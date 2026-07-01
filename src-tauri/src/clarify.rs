//! Fase de esclarecimento do Plan mode.
//!
//! Separa a DETEÇÃO da GERAÇÃO, porque a literatura mostra que pôr o modelo a auto-julgar "isto é
//! ambíguo?" é pouco fiável (tende a marcar perguntas claras como ambíguas), enquanto um detetor
//! determinístico com features baratas é mais robusto — sobretudo em modelos pequenos.
//!
//! - `specificity` (L1, determinístico, sem modelo): filtro de recall — deixa passar as mensagens
//!   claramente específicas e sinaliza as vagas.
//! - `clarifying_questions` (slots, EXTRAÇÃO — tarefa fácil): só corre quando vago; o modelo diz o
//!   que FALTA. Devolve `[]` quando já há o essencial, vetando os falsos positivos da L1.

use std::collections::HashMap;
use std::sync::OnceLock;

use tokio::sync::Mutex;

use crate::planner::{clean_step, lean_for_draft, parse_steps, with_instruction};
use crate::providers::ollama::{self, GenOpts};
use crate::providers::{claude_api, ChatMessage};
use crate::settings::Settings;

/// Palavras deíticas/referenciais (PT+EN). Sem um referente claro, sinalizam ambiguidade
/// pragmática — a maior classe de ambiguidade na literatura.
const DEICTIC: &[&str] = &[
    "isto", "isso", "aquilo", "este", "esse", "aquele", "esta", "essa", "aquela", "isos", "tal",
    "this", "that", "those", "these", "it",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Specificity {
    /// Constraints concretas suficientes → não perguntar.
    Clear,
    /// Indefinido pelas features → deixar a L2 (embeddings) decidir.
    Borderline,
    /// Claramente vago → perguntar (a extração de slots ainda veta).
    Vague,
}

/// Heurística determinística (L1): a mensagem traz constraints concretas suficientes para planear?
/// Soma sinais de especificidade (quantidades, dinheiro, comprimento) e penaliza deíticos sem
/// referente. Calibrado para errar do lado de NÃO chatear nas mensagens claramente específicas;
/// quando devolve `Vague`, é a extração de slots que decide se há mesmo algo a perguntar.
pub fn specificity(task: &str, bias: i32) -> Specificity {
    let lower = task.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let n_words = words.len();
    // Palavras que contêm um dígito ≈ quantidades (orçamento, VRAM, tamanho de modelo "70b", "q4").
    let n_numbers = words.iter().filter(|w| w.chars().any(|c| c.is_ascii_digit())).count();
    let has_money = task.contains('€') || task.contains('$') || lower.contains("eur") || lower.contains("usd");
    let n_deictic = words
        .iter()
        .filter(|w| {
            let bare = w.trim_matches(|c: char| !c.is_alphanumeric());
            DEICTIC.contains(&bare)
        })
        .count();

    let mut score: i32 = 0;
    if n_words >= 12 {
        score += 1;
    }
    if n_words >= 25 {
        score += 1;
    }
    score += n_numbers.min(3) as i32;
    if has_money {
        score += 1;
    }
    score -= n_deictic.min(2) as i32;
    // Viés adaptativo por modelo (+ = perguntar menos; − = perguntar mais). Mensagens curtas e vagas
    // já marcam score ≤ 0 naturalmente → Vague, sem precisar de regra especial.
    score += bias;

    // 3 vias: claros passam direto, vagos perguntam, e a banda do meio vai à L2 (embeddings).
    if score >= 3 {
        Specificity::Clear
    } else if score <= 0 {
        Specificity::Vague
    } else {
        Specificity::Borderline
    }
}

/// Sinais de pesquisa/atualidade (PT+EN) — a tarefa provavelmente precisa de `web_search`/`web_fetch`.
const WEB_SIGNALS: &[&str] = &[
    "pesquisa", "pesquisar", "procura", "procurar", "hoje", "atual", "atuais", "notícia", "notícias",
    "preço", "preços", "cotação", "tempo", "meteorologia", "previsão", "quanto custa", "quando é",
    "quem é", "quem foi", "últimas", "recente", "recentes", "site", "página web", "url",
    "search", "current", "latest", "news", "price", "weather", "forecast", "when is", "who is",
];

/// Sinais de operação de ficheiro/projeto — a tarefa provavelmente NÃO precisa de pesquisar a web.
const FILE_SIGNALS: &[&str] = &[
    "ficheiro", "arquivo", "pasta", "projeto", "cria", "criar", "edita", "editar", "grava", "gravar",
    "guarda", "guardar", "atualiza", "atualizar", "file", "folder", "create", "edit", "save", "write",
    "update",
];

/// A mensagem contém um token com "pinta" de extensão de ficheiro (`cv.html`, `main.py`) — evita
/// falsos positivos em decimais/preços ("3.5", "€19.99") exigindo que a parte antes do ponto não
/// seja só dígitos.
fn has_file_extension(lower: &str) -> bool {
    lower.split_whitespace().any(|w| {
        let w = w.trim_matches(|c: char| !c.is_alphanumeric() && c != '.');
        match w.rfind('.') {
            Some(pos) if pos > 0 => {
                let (base, ext) = w.split_at(pos);
                let ext = &ext[1..];
                !base.chars().all(|c| c.is_ascii_digit())
                    && (1..=5).contains(&ext.len())
                    && ext.chars().all(|c| c.is_ascii_alphabetic())
            }
            _ => false,
        }
    })
}

/// Heurística determinística e barata (L1, mesmo espírito de `specificity`): este turno precisa
/// mesmo de `web_search`/`web_fetch`, ou é claramente uma operação de ficheiro/projeto? Usada para
/// não oferecer tools de pesquisa irrelevantes a modelos locais pequenos, que degradam com muitas
/// tools simultâneas. **Fail-open**: qualquer ambiguidade (nenhum sinal forte, ou os dois lados
/// presentes) devolve `true` — nunca esconde `web_search` por engano.
pub fn wants_web(task: &str) -> bool {
    let lower = task.to_lowercase();
    let has_web = WEB_SIGNALS.iter().any(|s| lower.contains(s));
    let has_file = FILE_SIGNALS.iter().any(|s| lower.contains(s)) || has_file_extension(&lower);
    !(has_file && !has_web)
}

/// Exemplos curados (bilingue) para a L2: o centróide dos vagos vs dos específicos no espaço de
/// embeddings classifica os casos fronteira. Não precisa de treino — só de cosseno.
const EXEMPLARS: &[(&str, bool)] = &[
    // (texto, is_vague)
    ("quero uma máquina para LLMs locais", true),
    ("ajuda-me com isto", true),
    ("ajuda-me a decidir sobre o meu setup", true),
    ("faz-me um site", true),
    ("melhora isto", true),
    ("I want a machine for local LLMs", true),
    ("make me something cool with this", true),
    ("máquina ~€2000 para correr Llama 70B Q4 em Portugal", false),
    ("escreve um email formal de agradecimento ao cliente ACME em português", false),
    ("implementa quicksort em Rust com testes unitários", false),
    ("build a PC around €2500 to run 70B models locally in the EU", false),
    ("compara RTX 4090 vs RX 7900 XTX para inferência de 13B em Q5", false),
    ("resume este artigo em 5 bullet points em português", false),
    ("corrige o bug de off-by-one nesta função de paginação", false),
];

#[allow(clippy::type_complexity)]
static EXEMPLAR_CACHE: OnceLock<Mutex<HashMap<String, Vec<(bool, Vec<f32>)>>>> = OnceLock::new();
fn exemplar_cache() -> &'static Mutex<HashMap<String, Vec<(bool, Vec<f32>)>>> {
    EXEMPLAR_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Classifica `q` pelo centróide (média) mais próximo: vago vs específico. Puro → testável sem rede.
fn nearest_centroid_vague(exemplars: &[(bool, Vec<f32>)], q: &[f32]) -> Option<bool> {
    let centroid = |want_vague: bool| -> Vec<f32> {
        let mut sum: Vec<f32> = Vec::new();
        let mut n = 0u32;
        for (is_vague, e) in exemplars.iter().filter(|(v, _)| *v == want_vague) {
            let _ = is_vague;
            if sum.is_empty() {
                sum = vec![0.0; e.len()];
            }
            for (i, x) in e.iter().enumerate() {
                if i < sum.len() {
                    sum[i] += x;
                }
            }
            n += 1;
        }
        if n > 0 {
            for x in &mut sum {
                *x /= n as f32;
            }
        }
        sum
    };
    let cv = centroid(true);
    let cs = centroid(false);
    if cv.is_empty() || cs.is_empty() {
        return None;
    }
    Some(ollama::cosine(q, &cv) > ollama::cosine(q, &cs))
}

/// Resolve qual modelo usar para embeddings (cache de processo): o override `embed_model` se estiver
/// instalado, senão **auto-deteta** um modelo de embeddings instalado (nome com "embed"/"bge"/"minilm"/
/// "e5"/"gte"). `None` se não houver nenhum (os modelos de chat não embutem) → L2 dormente.
async fn resolve_embed_model(settings: &Settings) -> Option<String> {
    static RESOLVED: OnceLock<Mutex<Option<Option<String>>>> = OnceLock::new();
    let cell = RESOLVED.get_or_init(|| Mutex::new(None));
    let mut g = cell.lock().await;
    if let Some(cached) = g.as_ref() {
        return cached.clone(); // já resolvido (Some(model) ou None)
    }
    let installed = ollama::list_models(&settings.ollama_endpoint).await.unwrap_or_default();
    let configured = settings.embed_model.trim();
    let pick = if !configured.is_empty()
        && installed
            .iter()
            .any(|m| m == configured || m.starts_with(&format!("{configured}:")))
    {
        Some(configured.to_string())
    } else {
        installed.into_iter().find(|m| is_embed_model_name(m))
    };
    *g = Some(pick.clone());
    pick
}

/// Heurística por nome: parece um modelo de embeddings (vs. um modelo de chat)?
pub(crate) fn is_embed_model_name(name: &str) -> bool {
    let l = name.to_lowercase();
    l.contains("embed") || l.contains("bge") || l.contains("minilm") || l.contains("e5") || l.contains("gte")
}

/// L2 (embeddings): para os casos fronteira, a mensagem é vaga? Usa um modelo de embeddings instalado
/// (auto-detetado; os modelos de chat não embutem). Embute os exemplos (cache por modelo) e a `task`, e
/// compara centróides. `None` se não houver modelo de embeddings ou se falharem → chamador trata como vago.
/// Cache negativa: um modelo que falhe é marcado para não voltar a martelar o `/api/embed` (ex.: 501/404).
pub async fn embedding_vague(settings: &Settings, task: &str) -> Option<bool> {
    let endpoint = &settings.ollama_endpoint;
    let model = resolve_embed_model(settings).await?;
    let model = model.as_str();
    let exemplars = {
        let mut cache = exemplar_cache().lock().await;
        match cache.get(model) {
            Some(e) if e.is_empty() => return None, // já falhou antes → não re-tenta
            Some(e) => e.clone(),
            None => {
                let texts: Vec<&str> = EXEMPLARS.iter().map(|(t, _)| *t).collect();
                match ollama::embed(endpoint, model, &texts).await {
                    Ok(embs) if embs.len() == EXEMPLARS.len() => {
                        let built: Vec<(bool, Vec<f32>)> =
                            EXEMPLARS.iter().map(|(_, v)| *v).zip(embs).collect();
                        cache.insert(model.to_string(), built.clone());
                        built
                    }
                    _ => {
                        cache.insert(model.to_string(), Vec::new()); // marca falha (cache negativa)
                        return None;
                    }
                }
            }
        }
    };
    let q = ollama::embed(endpoint, model, &[task]).await.ok()?.into_iter().next()?;
    nearest_centroid_vague(&exemplars, &q)
}

/// Gera 1-3 perguntas de esclarecimento por EXTRAÇÃO de slots em falta. Devolve vazio quando já há
/// o essencial (o modelo veta) ou se a chamada falhar. Acumula tokens em `total_in/out`.
pub async fn clarifying_questions(
    settings: &Settings,
    use_api: bool,
    model: &str,
    messages: &[ChatMessage],
    base_opts: GenOpts,
    total_in: &mut u64,
    total_out: &mut u64,
    force_fallback: bool,
) -> Vec<String> {
    let instruction = "[ESCLARECER] Olha para TODA esta conversa, não só a última mensagem. Se o ESSENCIAL \
(objetivo, escala/dimensão, restrições/orçamento, contexto/região, formato) JÁ foi dito em QUALQUER mensagem \
(minha ou tua), considera-o CONHECIDO e NÃO voltes a perguntar sobre isso. Só se faltar mesmo algo essencial \
é que fazes 1 a 3 perguntas CURTAS sobre o que FALTA (uma por elemento). Se já há o essencial, responde \
APENAS com []. NÃO respondas à tarefa nem planeies. Responde APENAS com um array JSON de strings, nada mais.";
    // Contexto enxuto + instrução na última mensagem (mesmo padrão do rascunho do plano).
    let msgs = with_instruction(&lean_for_draft(messages), instruction);
    let opts = GenOpts { num_predict: Some(256), temperature: Some(0.2), ..base_opts };

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
        ollama::chat_stream(&settings.ollama_endpoint, model, &msgs, opts, false, |_| {}, |_| {})
            .await
            .map(|r| {
                *total_in += r.input_tokens;
                *total_out += r.output_tokens;
                r.text
            })
            .unwrap_or_default()
    };
    let cleaned = clean_step(&text);
    let mut qs = parse_steps(&cleaned);
    qs.truncate(3);
    // A deteção (L1+L2) já disse "vago". Se o parse falhou por FORMATO (não um veto explícito "[]"),
    // faz perguntas genéricas — a clarificação nunca fica muda quando o pedido é mesmo vago. A região
    // entra aqui (resolve as fontes BR vs PT/UE pela resposta do utilizador, sem enviesar a pesquisa).
    if force_fallback && qs.is_empty() && !cleaned.contains("[]") {
        qs = default_questions();
    }
    qs
}

/// Perguntas-template genéricas (sem chamar o modelo) — usadas pelo nível `light` e como fallback do
/// `clarifying_questions` quando a deteção já disse "vago" mas o parse das perguntas do modelo falhou.
pub fn default_questions() -> Vec<String> {
    vec![
        "Qual é o objetivo concreto e em que país/região?".to_string(),
        "Há restrições a ter em conta (ex.: orçamento, prazo, formato)?".to_string(),
    ]
}

/// Cascata de clarificação para o CHAT, conforme o nível (`off|light|medium|high`). Vazio = não perguntar.
/// A (gate determinístico, `specificity`) filtra barato; B (modelo, `clarifying_questions`) gera/veta nos
/// níveis medium/high. O planner mantém o seu próprio caminho (A-force) — isto é só do chat.
#[allow(clippy::too_many_arguments)]
pub async fn gate(
    settings: &Settings,
    use_api: bool,
    model: &str,
    messages: &[ChatMessage],
    level: &str,
    is_followup: bool,
    opts: GenOpts,
    total_in: &mut u64,
    total_out: &mut u64,
) -> Vec<String> {
    if level == "off" {
        return Vec::new();
    }
    // Texto da última mensagem do utilizador (sem texto — ex.: só imagem — não perguntar).
    let task = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.trim().to_string())
        .unwrap_or_default();
    if task.is_empty() {
        return Vec::new();
    }
    // Follow-ups (o assistente já respondeu antes): só o nível `high` clarifica a meio da conversa.
    // light/medium clarificam SÓ o pedido inicial — evita reperguntar o que já foi respondido (o veto
    // do B é frágil em modelos locais pequenos).
    if is_followup && level != "high" {
        return Vec::new();
    }
    let bias = settings.clarify_bias.get(model).copied().unwrap_or(0);
    let level_bias = if level == "high" { -1 } else { 0 }; // high pergunta mais cedo
    let spec = specificity(&task, bias + level_bias);

    if level == "light" {
        // A só: vago de alta confiança; perguntas-template (sem modelo).
        if spec != Specificity::Vague {
            return Vec::new();
        }
        log::info!("[clarify] chat light spec={spec:?} → template");
        return default_questions();
    }

    // medium / high: A→B. Borderline confirma-se pela L2 (ou, sem L2 instalado, deixa o B decidir).
    let candidate = match spec {
        Specificity::Clear => false,
        Specificity::Vague => true,
        Specificity::Borderline => embedding_vague(settings, &task).await.unwrap_or(true),
    };
    log::info!("[clarify] chat level={level} spec={spec:?} bias={bias} candidate={candidate}");
    if !candidate {
        return Vec::new();
    }
    // B gera/veta (force_fallback=false → veto respeitado: parse-fail/[] → não pergunta).
    clarifying_questions(settings, use_api, model, messages, opts, total_in, total_out, false).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vague_short_prompts() {
        assert_eq!(specificity("Quero uma máquina para LLMs locais", 0), Specificity::Vague);
        assert_eq!(specificity("I want a machine for local LLMs", 0), Specificity::Vague);
        assert_eq!(specificity("ajuda-me com isto", 0), Specificity::Vague);
        assert_eq!(specificity("preços de GPUs?", 0), Specificity::Vague);
    }

    #[test]
    fn clear_specific_prompts() {
        assert_eq!(
            specificity("Máquina ~€2000, correr Llama 70B Q4 em Portugal", 0),
            Specificity::Clear
        );
        assert_eq!(
            specificity("Build a PC around €2500 to run 70B models locally in the EU", 0),
            Specificity::Clear
        );
    }

    #[test]
    fn longish_but_underspecified_is_borderline() {
        // Sem orçamento, tamanho de modelo nem região → fronteira → vai à L2 (embeddings) decidir.
        assert_eq!(
            specificity("Quero fazer uma máquina boa para hospedar LLMs locais, quais os preços e onde comprar", 0),
            Specificity::Borderline
        );
    }

    #[test]
    fn bias_shifts_the_band() {
        // Viés positivo (utilizador salta muito) → pergunta menos; negativo → pergunta mais.
        let q = "Quero fazer uma máquina boa para hospedar LLMs locais, quais os preços e onde comprar";
        assert_eq!(specificity(q, 0), Specificity::Borderline);
        assert_eq!(specificity(q, 2), Specificity::Clear); // 1 + 2 = 3 → Clear
        assert_eq!(specificity(q, -1), Specificity::Vague); // 1 - 1 = 0 → Vague
    }

    #[test]
    fn wants_web_true_for_search_and_current_events() {
        assert!(wants_web("qual é o preço do Bitcoin hoje"));
        assert!(wants_web("what's the weather like tomorrow"));
        assert!(wants_web("pesquisa as últimas notícias sobre Portugal"));
    }

    #[test]
    fn wants_web_false_for_clear_file_requests() {
        assert!(!wants_web("cria o cv_preview.html com este conteúdo"));
        assert!(!wants_web("edita o ficheiro main.py e corrige o bug"));
        assert!(!wants_web("guarda isto na pasta do projeto"));
    }

    #[test]
    fn wants_web_fails_open_when_both_or_neither_signal() {
        // Ambos os sinais → mantém web (pode precisar de pesquisar para escrever o ficheiro).
        assert!(wants_web("pesquisa o preço atual do Bitcoin e grava num ficheiro relatorio.md"));
        // Nenhum sinal → mantém web por omissão (fail-open).
        assert!(wants_web("bom dia, tudo bem?"));
    }

    #[test]
    fn file_extension_ignores_decimals_and_prices() {
        assert!(!wants_web("cria um ficheiro cv.html")); // tem sinal de ficheiro explícito também
        assert!(has_file_extension("cria o cv_preview.html"));
        assert!(!has_file_extension("custa 3.5 euros"));
        assert!(!has_file_extension("são €19.99"));
    }

    #[test]
    fn centroid_classifies_by_nearest() {
        // Vetores sintéticos: vagos ≈ eixo X, específicos ≈ eixo Y.
        let exemplars = vec![
            (true, vec![1.0, 0.0]),
            (true, vec![0.9, 0.1]),
            (false, vec![0.0, 1.0]),
            (false, vec![0.1, 0.9]),
        ];
        assert_eq!(nearest_centroid_vague(&exemplars, &[1.0, 0.05]), Some(true));
        assert_eq!(nearest_centroid_vague(&exemplars, &[0.05, 1.0]), Some(false));
    }
}
