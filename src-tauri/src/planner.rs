//! Plan mode ("planeamento profundo"): o modelo rascunha um plano de passos ACIONÁVEIS, o
//! utilizador aprova/edita/rejeita, e o andaime executa cada passo em sequência (raciocínio/
//! escrita, opcionalmente fundamentado na web quando o 🔎 está ligado). Irmão do `deep_research`:
//! o código orquestra os passos; o modelo só preenche o conteúdo de cada um.

use anyhow::Result;

use crate::clarify;
use crate::providers::ollama::{self, GenOpts};
use crate::providers::{claude_api, ChatMessage, LlmResponse};
use crate::settings::Settings;
use crate::tools::web;

const MAX_STEPS: usize = 7;
const PRIOR_CAP: usize = 4000; // contexto das saídas anteriores levado a cada passo

fn last_user(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn msg(role: &str, content: String) -> ChatMessage {
    ChatMessage { role: role.into(), content, attachments: Vec::new() }
}

/// Acrescenta uma instrução à ÚLTIMA mensagem do utilizador, preservando todo o histórico e a
/// alternância de papéis. Assim o modelo planeia/executa COM o contexto da conversa (e não sobre
/// uma linha solta como "dá-me exemplos", que sozinha não tem significado).
pub(crate) fn with_instruction(messages: &[ChatMessage], instruction: &str) -> Vec<ChatMessage> {
    let mut m = messages.to_vec();
    if let Some(last) = m.iter_mut().rev().find(|x| x.role == "user") {
        last.content = format!("{}\n\n{instruction}", last.content);
    } else {
        m.push(msg("user", instruction.to_string()));
    }
    m
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// Para o RASCUNHO do plano: histórico enxuto. Os resultados de planos anteriores têm milhares de
/// caracteres e, repetidos no contexto, afogam a instrução → o modelo pequeno degenera em ECO da
/// pergunta. Limita cada mensagem antiga; a ÚLTIMA do utilizador (que leva a instrução) fica completa.
/// Remove a mensagem de sistema (persona/honestidade/PDF nudge da rota normal). O Plan mode é um
/// andaime com instruções próprias por fase; herdar o system prompt do chat fazia o modelo (a) sangrar
/// o "clica em Export PDF" para dentro dos passos e (b) hedge a mais ("não posso fazer isto").
fn strip_system(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages.iter().filter(|m| m.role != "system").cloned().collect()
}

pub(crate) fn lean_for_draft(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let last_user = messages.iter().rposition(|m| m.role == "user");
    messages
        .iter()
        .enumerate()
        .map(|(i, m)| {
            if Some(i) == last_user {
                m.clone()
            } else {
                ChatMessage { role: m.role.clone(), content: truncate(&m.content, 400), attachments: Vec::new() }
            }
        })
        .collect()
}

/// Extrai os passos/perguntas. Tenta (1) array JSON de strings (robusto a texto à volta), (2) lista
/// markdown numerada/com marcadores, (3) extração leniente das strings entre aspas dentro do `[...]`.
/// O (3) recupera o formato torto que os modelos pequenos às vezes emitem — `[{"texto"}, …]` (objetos/
/// JSON inválido) em vez de `["texto", …]` — que de outro modo daria 0 itens.
pub(crate) fn parse_steps(text: &str) -> Vec<String> {
    if let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) {
        if b >= a {
            if let Ok(v) = serde_json::from_str::<Vec<String>>(&text[a..=b]) {
                let steps: Vec<String> = v
                    .into_iter()
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                if !steps.is_empty() {
                    return steps;
                }
            }
        }
    }
    let list = parse_list_lines(text);
    if !list.is_empty() {
        return list;
    }
    parse_quoted_in_array(text)
}

/// Fallback final: extrai as strings entre aspas do primeiro `[...]`. Recupera `[{"pergunta"}, …]` e
/// variantes mal-formadas. Ignora strings com menos de 4 chars (ruído/keys curtas). Uma recusa em prosa
/// ou um `[]` não têm aspas dentro → devolvem vazio (não disparam falsos itens).
fn parse_quoted_in_array(text: &str) -> Vec<String> {
    let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) else {
        return Vec::new();
    };
    if b <= a {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_str = false;
    let mut escaped = false;
    for ch in text[a..=b].chars() {
        if in_str {
            if escaped {
                cur.push(ch);
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                let s = cur.trim().to_string();
                if s.chars().count() >= 4 {
                    out.push(s);
                }
                cur.clear();
                in_str = false;
            } else {
                cur.push(ch);
            }
        } else if ch == '"' {
            in_str = true;
        }
    }
    out
}

/// Fallback: extrai itens de uma lista numerada (`1.`/`1)`) ou com marcadores (`-`/`*`/`•`).
/// Linhas sem marcador de lista são ignoradas (uma recusa em prosa não gera passos).
fn parse_list_lines(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let line = raw.trim();
        let mut chars = line.chars().peekable();
        let mut matched = false;
        let mut num = 0usize;
        while matches!(chars.peek(), Some(c) if c.is_ascii_digit()) {
            chars.next();
            num += 1;
        }
        if num > 0 {
            if matches!(chars.peek(), Some('.') | Some(')')) {
                chars.next();
                matched = true;
            }
        } else if matches!(chars.peek(), Some('-') | Some('*') | Some('•')) {
            chars.next();
            matched = true;
        }
        if !matched {
            continue;
        }
        let rest: String = chars.collect();
        let item = rest
            .trim()
            .trim_matches(|c: char| c == '*' || c == '`' || c == '#' || c == ' ')
            .trim()
            .to_string();
        if !item.is_empty() {
            out.push(item);
        }
    }
    out
}

/// Limpa a saída de um passo: remove blocos/tags `<think>…</think>` (vazamento de raciocínio) e
/// desembrulha cercas de código que envolvam toda a resposta (`​```markdown … ​````), que de outro modo
/// seriam extraídas como artefactos separados.
pub(crate) fn clean_step(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    // Remove blocos <think>…</think> completos.
    while let Some(open) = rest.to_lowercase().find("<think>") {
        out.push_str(&rest[..open]);
        let after = &rest[open + "<think>".len()..];
        match after.to_lowercase().find("</think>") {
            Some(close) => rest = &after[close + "</think>".len()..],
            None => {
                rest = ""; // <think> sem fecho → descarta o resto do bloco de raciocínio
                break;
            }
        }
    }
    out.push_str(rest);
    // Remove tags soltas que tenham sobrado (ex.: um </think> órfão no início).
    let mut cleaned = out.replace("</think>", "").replace("<think>", "");
    cleaned = cleaned.trim().to_string();
    // Desembrulha uma cerca de código que envolva toda a resposta.
    if cleaned.starts_with("```") {
        if let Some(first_nl) = cleaned.find('\n') {
            let fence_lang = cleaned[3..first_nl].trim();
            let body_and_close = &cleaned[first_nl + 1..];
            if fence_lang.is_empty() || fence_lang.chars().all(|c| c.is_ascii_alphanumeric()) {
                if let Some(close) = body_and_close.rfind("```") {
                    // Só desembrulha se a cerca de fecho é mesmo o fim (toda a resposta era um bloco).
                    if body_and_close[close + 3..].trim().is_empty() {
                        cleaned = body_and_close[..close].trim().to_string();
                    }
                }
            }
        }
    }
    cleaned
}

/// Plan mode. `approve(draft)` emite o plano à UI e devolve `None` (rejeitado) ou os passos
/// (possivelmente editados). `on_step(i, status)`, `on_delta(texto)`, `on_tool(nome, detalhe)`.
/// Gera uma query de pesquisa curta (palavras-chave) por passo, numa SÓ chamada. Os títulos dos passos
/// são rótulos de processo ("Cálculo do custo…") — maus como queries; isto produz entidades + a
/// região/orçamento que o utilizador esclareceu (vê-os via `conv`). Vazio em falha → o chamador cai no
/// título do passo. Reusa o parse leniente (lida com `[{"…"}]`).
#[allow(clippy::too_many_arguments)]
async fn step_queries(
    settings: &Settings,
    use_api: bool,
    model: &str,
    conv: &[ChatMessage],
    plan_list: &str,
    n: usize,
    opts: GenOpts,
    total_in: &mut u64,
    total_out: &mut u64,
) -> Vec<String> {
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let instruction = format!(
        "[QUERIES · hoje é {today}] Para CADA passo do plano, escreve UMA query de pesquisa web curta \
(3-7 palavras-chave, entidades concretas — modelos, marcas, preço, lojas; inclui o país/região se for \
relevante para preços ou lojas, usando o contexto que dei). NÃO uses verbos de planeamento ('definir', \
'selecionar', 'calcular', 'pesquisar'); escreve como pesquisarias no Google. Plano:\n{plan_list}\n\n\
Responde APENAS com um array JSON de {n} strings (uma query por passo, pela ordem), nada mais."
    );
    let msgs = with_instruction(&lean_for_draft(conv), &instruction);
    let qopts = GenOpts { num_predict: Some(256), temperature: Some(0.2), ..opts };
    let text = if use_api {
        claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens, &msgs, false)
            .await
            .map(|r| {
                *total_in += r.input_tokens;
                *total_out += r.output_tokens;
                r.text
            })
            .unwrap_or_default()
    } else {
        ollama::chat_stream(&settings.ollama_endpoint, model, &msgs, qopts, false, |_| {}, |_| {})
            .await
            .map(|r| {
                *total_in += r.input_tokens;
                *total_out += r.output_tokens;
                r.text
            })
            .unwrap_or_default()
    };
    let mut qs = parse_steps(&clean_step(&text));
    qs.truncate(n);
    qs
}

#[allow(clippy::too_many_arguments)]
pub async fn run<A, B, F, G, S, D, T>(
    settings: &Settings,
    use_api: bool,
    model: &str,
    messages: &[ChatMessage],
    opts: GenOpts,
    clarify_level: &str,
    ask: B,
    approve: A,
    mut on_step: S,
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    A: FnOnce(Vec<String>, bool) -> F,
    F: std::future::Future<Output = Option<(Vec<String>, bool)>>,
    B: FnOnce(Vec<String>) -> G,
    G: std::future::Future<Output = Option<Vec<String>>>,
    S: FnMut(usize, &str),
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let task = last_user(messages);
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut sources: Vec<(String, String)> = Vec::new();
    // Conversa de trabalho SEM o system prompt da persona (o planner usa instruções próprias por
    // fase). Pode ganhar os esclarecimentos do utilizador antes de planear.
    let mut conv: Vec<ChatMessage> = strip_system(messages);

    // ── Fase 0: esclarecer (determinístico decide SE perguntar; o modelo gera as perguntas) ──
    if clarify_level != "off" {
        // Viés adaptativo por modelo (aprende com responder/saltar os cartões).
        let bias = settings.clarify_bias.get(model).copied().unwrap_or(0);
        // L1 determinística decide claros/vagos; a banda fronteira vai à L2 (embeddings, se ativa).
        let spec = clarify::specificity(&task, bias);
        let vague = match spec {
            clarify::Specificity::Clear => false,
            clarify::Specificity::Vague => true,
            clarify::Specificity::Borderline => {
                clarify::embedding_vague(settings, &task).await.unwrap_or(true)
            }
        };
        log::info!("[clarify] spec={spec:?} bias={bias} vague={vague}");
        if vague {
            let qs = clarify::clarifying_questions(settings, use_api, model, &conv, opts, &mut total_in, &mut total_out, true).await;
            log::info!("[clarify] perguntas={}", qs.len());
            if !qs.is_empty() {
                if let Some(answers) = ask(qs.clone()).await {
                    let qa = qs
                        .iter()
                        .zip(answers.iter())
                        .filter(|(_, a)| !a.trim().is_empty())
                        .map(|(q, a)| format!("- {q} {}", a.trim()))
                        .collect::<Vec<_>>()
                        .join("\n");
                    if !qa.is_empty() {
                        conv = with_instruction(&conv, &format!("Esclarecimentos que dei:\n{qa}"));
                    }
                }
            }
        }
    }

    // Chamada one-shot (texto limpo) — local sem thinking, ou Claude.
    // ── Fase 1: planear (COM o contexto da conversa) ────────────────────────────────────────
    on_tool("plan", "draft");
    let plan_instruction = format!(
        "[MODO PLANO · hoje é {today}] Em vez de responderes diretamente, divide a minha ÚLTIMA mensagem \
(interpretada no contexto desta conversa) num PLANO de 3 a 7 passos ACIONÁVEIS, distintos e ordenados — cada \
passo um título curto e concreto do que vai produzir. NÃO repitas a pergunta como passo. Responde APENAS com \
um array JSON de strings (os passos), nada mais."
    );
    // Temperatura BAIXA no rascunho: é uma extração estruturada (array JSON), não escrita criativa.
    // Com a temperatura criativa do utilizador, o modelo desvia-se do formato (ou inventa recusas
    // tipo "[Erro] …") e o parse falha → caía no eco da pergunta.
    let plan_opts = GenOpts { num_predict: Some(1024), temperature: Some(0.2), ..opts };
    // Histórico enxuto SÓ no rascunho: evita que outputs de planos anteriores afoguem a instrução.
    let plan_msgs = with_instruction(&lean_for_draft(&conv), &plan_instruction);
    let dz = if use_api {
        claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens, &plan_msgs, false).await?
    } else {
        ollama::chat_stream(&settings.ollama_endpoint, model, &plan_msgs, plan_opts, false, |_| {}, |_| {}).await?
    };
    total_in += dz.input_tokens;
    total_out += dz.output_tokens;
    // `clean_step` aqui também: o modelo pode vazar `<think>` no rascunho e estragar o parse.
    let mut draft = parse_steps(&clean_step(&dz.text));
    draft.truncate(MAX_STEPS);

    // Eco: o rascunho veio com 0-1 passos (repete a pergunta). A temperatura baixa é quase-greedy,
    // por isso repetir a MESMA chamada cai no MESMO eco (falhas correlacionadas). A regeneração SOBE
    // a temperatura (escapa ao "poço") e usa uma instrução imperativa com exemplo inline.
    if draft.len() < 2 {
        let retry_instr = format!(
            "{plan_instruction}\n\nCRÍTICO: devolve SÓ o array JSON dos passos, por exemplo \
[\"Primeiro passo\", \"Segundo passo\", \"Terceiro passo\"]. NÃO respondas à pergunta nem a repitas como passo."
        );
        for &temp in &[0.5_f32, 0.85_f32] {
            let retry_opts = GenOpts { temperature: Some(temp), ..plan_opts };
            let retry_msgs = with_instruction(&lean_for_draft(&conv), &retry_instr);
            let resp = if use_api {
                claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens, &retry_msgs, false).await.ok()
            } else {
                ollama::chat_stream(&settings.ollama_endpoint, model, &retry_msgs, retry_opts, false, |_| {}, |_| {}).await.ok()
            };
            if let Some(d) = resp {
                total_in += d.input_tokens;
                total_out += d.output_tokens;
                let mut retry = parse_steps(&clean_step(&d.text));
                retry.truncate(MAX_STEPS);
                if retry.len() >= 2 {
                    draft = retry;
                    break;
                }
            }
        }
        log::info!("[plan] eco detetado → regeneração (temp crescente); passos finais={}", draft.len());
    }
    if draft.is_empty() {
        draft = vec![task.clone()]; // fallback final: um único passo
    }

    // Classificação leve (SIM/NAO) à parte: o plano precisa de dados atuais/online? Pôr este flag
    // DENTRO do JSON dos passos faz os modelos pequenos colapsarem para um array vazio — por isso é
    // uma chamada minúscula separada (num_predict curto), sobre os passos já rascunhados.
    log::info!("[plan] {} passos rascunhados", draft.len());

    // ── Fase 2: aprovar / editar / rejeitar ──────────────────────────────────────────────────
    // Oferecemos SEMPRE a escalada para a web no cartão (pré-marcada quando o 🔎 está desligado).
    // A classificação automática "precisa de web?" era pouco fiável — dizia NÃO a planos que
    // claramente beneficiavam de dados atuais (dois rascunhos da mesma pergunta davam veredictos
    // opostos). Quem decide é o utilizador, na aprovação.
    let (steps, research) = match approve(draft, true).await {
        Some((s, r)) if !s.is_empty() => (s, r),
        _ => {
            let txt = "Plano rejeitado.".to_string();
            on_delta(&txt);
            return Ok(LlmResponse { text: txt, input_tokens: total_in, output_tokens: total_out, reported_cost_usd: 0.0, sources: Vec::new() });
        }
    };

    log::info!("[plan] aprovado: {} passos, research(web)={research}", steps.len());

    // ── Fase 3: executar passo a passo ──────────────────────────────────────────────────────
    let plan_list = steps
        .iter()
        .enumerate()
        .map(|(i, s)| format!("{}. {s}", i + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let mut final_text = String::new();
    let mut prior = String::new();
    let step_opts = GenOpts { num_ctx: opts.num_ctx.max(8192), num_predict: Some(2048), ..opts };

    // Queries de pesquisa focadas (uma só chamada) — só quando há grounding. Os títulos dos passos são
    // rótulos de processo; isto dá palavras-chave/entidades + região esclarecida. Fallback ao título.
    let queries: Vec<String> = if research {
        let q = step_queries(settings, use_api, model, &conv, &plan_list, steps.len(), opts, &mut total_in, &mut total_out).await;
        log::info!("[plan] queries: {q:?}");
        q
    } else {
        Vec::new()
    };

    for (i, step) in steps.iter().enumerate() {
        let is_last = i + 1 == steps.len();
        on_step(i, "executing");
        let heading = format!("\n\n## {}. {step}\n", i + 1);
        on_delta(&heading);
        final_text.push_str(&heading);

        // Grounding leve (só excertos) quando o 🔎 está ligado.
        let mut evidence = String::new();
        if research {
            // Query focada do passo (fallback ao título se faltar/vazia/parse falhou).
            let q = queries
                .get(i)
                .map(String::as_str)
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(step.as_str());
            on_step(i, "searching"); // marca o passo como "a pesquisar" na checklist
            on_tool("web_search", q);
            let results = web::web_search(&settings.web_search_provider, &settings.active_web_key(), q, 3)
                .await
                .unwrap_or_default();
            for r in &results {
                if !r.url.is_empty() && !sources.iter().any(|(_, u)| u == &r.url) {
                    sources.push((r.title.clone(), r.url.clone()));
                }
            }
            if !results.is_empty() {
                evidence = format!("\n\nEvidências da web (usa SÓ estes URLs; não inventes outros):\n{}", truncate(&web::format_results(&results), 1200));
            }
            on_step(i, "executing"); // pesquisa feita → volta a "a executar" (geração do passo)
        }

        // Os passos intermédios produzem só o seu conteúdo; só o ÚLTIMO pode concluir/fechar.
        let closing = if is_last {
            "Este é o ÚLTIMO passo: podes fechar com uma conclusão breve que ligue os passos. Mesmo assim, não ofereças mais ações nem faças perguntas ao utilizador."
        } else {
            "Produz só o conteúdo deste passo. NÃO concluas, NÃO resumas, NÃO ofereças pesquisar/fazer mais, NÃO faças perguntas ao utilizador. Termina assim que o passo estiver coberto."
        };
        let step_instruction = format!(
            "[MODO PLANO · passo {n}/{total} · hoje é {today}] Plano completo:\n{plan_list}\n\n\
Já produzido (resumo):\n{prior_txt}\n\nExecuta AGORA, no contexto da conversa, SÓ o passo {n}: «{step}». \
Produz o resultado em Markdown, conciso e concreto. NÃO repitas o plano, a pergunta nem os passos anteriores. \
NUNCA inventes URLs, links, preços, IDs ou NOMES DE PRODUTOS/MODELOS: menciona só produtos e modelos que \
apareçam nas evidências ou que conheças com CERTEZA; na dúvida, di-lo em vez de inventar. Quando houver \
evidências da web, CONFIA nelas acima do teu conhecimento — se uma evidência menciona um produto recente, \
ele EXISTE (não digas «não confirmado» nem «incerto»). Usa SEMPRE euros (€); nunca mistures libras (£) nem \
dólares ($). Só inclui um link se tiveres a certeza de que existe; na dúvida, refere a fonte pelo NOME \
(ex.: «PCDiga»). {closing} Se faltar um dado, di-lo numa linha. NÃO envolvas a resposta num bloco de código.{evidence}",
            n = i + 1,
            total = steps.len(),
            prior_txt = truncate(&prior, PRIOR_CAP)
        );
        let step_msgs = with_instruction(&conv, &step_instruction);
        // Stream ao vivo: com `think:false` o conteúdo já vem limpo (o raciocínio vai para um canal
        // separado), por isso não é preciso bufferizar para limpar — os tokens vão direto ao chat.
        // O caminho Claude é não-stream, por isso emite o texto de uma vez.
        let out = if use_api {
            match claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens, &step_msgs, false).await {
                Ok(resp) => { on_delta(&resp.text); resp }
                Err(e) => { on_step(i, "error"); on_delta(&format!("(falha: {e})")); continue; }
            }
        } else {
            match ollama::chat_stream(&settings.ollama_endpoint, model, &step_msgs, step_opts, false, |d| on_delta(d), |_| {}).await {
                Ok(resp) => resp,
                Err(e) => { on_step(i, "error"); on_delta(&format!("(falha: {e})")); continue; }
            }
        };
        total_in += out.input_tokens;
        total_out += out.output_tokens;
        final_text.push_str(&out.text);
        prior.push_str(&format!("[{}] {}\n", i + 1, truncate(&out.text, 600)));
        on_step(i, "done");
    }

    // Fontes acumuladas (dos passos fundamentados).
    if !sources.is_empty() {
        let mut f = String::from("\n\n## Fontes\n");
        for (i, (title, url)) in sources.iter().enumerate() {
            let label = if title.trim().is_empty() { url } else { title };
            f.push_str(&format!("{}. [{}]({})\n", i + 1, label, url));
        }
        on_delta(&f);
        final_text.push_str(&f);
    }

    Ok(LlmResponse { text: final_text, input_tokens: total_in, output_tokens: total_out, reported_cost_usd: 0.0, sources: Vec::new() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_step_strips_think_block() {
        let s = "<think>raciocínio interno</think>Resposta final.";
        assert_eq!(clean_step(s), "Resposta final.");
    }

    #[test]
    fn clean_step_strips_orphan_close_tag() {
        let s = "</think>\nConteúdo do passo.";
        assert_eq!(clean_step(s), "Conteúdo do passo.");
    }

    #[test]
    fn clean_step_unwraps_full_code_fence() {
        let s = "```markdown\n# Título\nTexto.\n```";
        assert_eq!(clean_step(s), "# Título\nTexto.");
    }

    #[test]
    fn clean_step_keeps_inline_code_fence() {
        // Uma cerca que NÃO envolve toda a resposta deve manter-se intacta.
        let s = "Antes\n```\ncode\n```\nDepois";
        assert_eq!(clean_step(s), s);
    }

    #[test]
    fn parse_steps_reads_array() {
        let steps = parse_steps(r#"texto à volta ["A", "B", "C"] fim"#);
        assert_eq!(steps.len(), 3);
        assert_eq!(steps[0], "A");
    }

    #[test]
    fn parse_steps_falls_back_to_numbered_list() {
        let steps = parse_steps("Aqui está o plano:\n1. Primeiro passo\n2. Segundo passo\n3) Terceiro");
        assert_eq!(steps, vec!["Primeiro passo", "Segundo passo", "Terceiro"]);
    }

    #[test]
    fn parse_steps_falls_back_to_bullets() {
        let steps = parse_steps("- **Um**\n* Dois\n• Três");
        assert_eq!(steps, vec!["Um", "Dois", "Três"]);
    }

    #[test]
    fn parse_steps_ignores_prose_refusal() {
        // Uma recusa em prosa (sem marcadores de lista) não deve gerar passos.
        assert!(parse_steps("[Erro] A sua mensagem não contém instruções válidas.").is_empty());
    }

    #[test]
    fn parse_steps_recovers_object_wrapped_strings() {
        // O 9B às vezes emite [{"pergunta"}, …] (objetos) em vez de ["…", …]; recuperamos as strings.
        let s = r#"[{"qual é o orçamento aproximado?"}, {"em que país/região?"}]"#;
        let out = parse_steps(s);
        assert_eq!(out.len(), 2);
        assert!(out[0].contains("orçamento"));
        assert!(out[1].contains("região"));
    }

    #[test]
    fn parse_steps_empty_array_yields_nothing() {
        assert!(parse_steps("[]").is_empty());
    }
}
