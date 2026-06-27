//! Pesquisa fundamentada ("grounded") para modelos LOCAIS pequenos.
//!
//! Um andaime determinístico (em Rust) que obriga o modelo a: decompor a pergunta em
//! sub-perguntas (Self-Ask), recolher factos frescos por sub-pergunta via pesquisa web,
//! verificar afirmações voláteis (Chain-of-Verification) e sintetizar SÓ a partir das
//! evidências. Não depende do tool-calling do modelo (que os pequenos fazem mal) nem da sua
//! memória (desatualizada) — desloca a carga de "recordar" para "resumir texto recolhido".

use anyhow::Result;

use crate::providers::ollama::{self, GenOpts};
use crate::providers::{ChatMessage, LlmResponse};
use crate::tools::web;

const MAX_SUBQ: usize = 6; // teto de sub-perguntas
const MAX_FETCH: usize = 5; // páginas abertas no total (Jina ~20/min)
const EVIDENCE_CAP: usize = 20_000; // caracteres de evidência levados à síntese

fn last_user(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn msg(role: &str, content: String) -> ChatMessage {
    ChatMessage {
        role: role.into(),
        content,
        attachments: Vec::new(),
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// Extrai o primeiro array JSON de strings do texto (robusto a texto à volta).
fn parse_json_array(text: &str) -> Vec<String> {
    let (Some(start), Some(end)) = (text.find('['), text.rfind(']')) else {
        return Vec::new();
    };
    if end < start {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(&text[start..=end])
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Uma chamada estruturada ao modelo local (sem thinking, para a saída ficar limpa).
async fn ask(endpoint: &str, model: &str, system: &str, user: &str, opts: GenOpts) -> Result<LlmResponse> {
    let msgs = vec![msg("system", system.to_string()), msg("user", user.to_string())];
    ollama::chat_stream(endpoint, model, &msgs, opts, false, |_| {}, |_| {}).await
}

/// Acrescenta as fontes novas (sem duplicar por URL).
fn collect_sources(sources: &mut Vec<(String, String)>, results: &[web::WebResult]) {
    for r in results {
        if !r.url.is_empty() && !sources.iter().any(|(_, u)| u == &r.url) {
            sources.push((r.title.clone(), r.url.clone()));
        }
    }
}

/// Pipeline fundamentada. Assinatura espelha `web_agent::run`.
/// `on_delta` recebe o texto final (streaming); `on_tool` recebe (nome, detalhe) das fases.
#[allow(clippy::too_many_arguments)]
pub async fn run<D, T>(
    endpoint: &str,
    model: &str,
    provider: &str,
    api_key: &str,
    full_messages: &[ChatMessage],
    opts: GenOpts,
    max_rounds: u32,
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let year = chrono::Local::now().format("%Y").to_string();
    let question = last_user(full_messages);

    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut sources: Vec<(String, String)> = Vec::new();

    // ── Fase 1: decompor (geral → específico, ancorado ao ano atual) ──────────────────────
    on_tool("research", "decompose");
    let decompose_sys = format!(
        "Hoje é {today}. És um planeador de investigação. NÃO respondas de memória — o teu trabalho é \
dividir a pergunta do utilizador em sub-perguntas que serão respondidas por PESQUISA web. Ordena do GERAL \
para o ESPECÍFICO: primeiro define o conceito, depois os componentes/partes, depois as opções ATUAIS de \
{year}, e por fim dados concretos (preços, especificações, datas). Cada sub-pergunta deve ser auto-contida, \
pesquisável e mencionar {year} quando fizer sentido. Responde APENAS com um array JSON de 4 a 6 strings \
(as sub-perguntas), nada mais."
    );
    let dz = ask(endpoint, model, &decompose_sys, &question, opts).await?;
    total_in += dz.input_tokens;
    total_out += dz.output_tokens;
    let mut subqs = parse_json_array(&dz.text);
    subqs.truncate(MAX_SUBQ);
    if subqs.is_empty() {
        subqs = vec![question.clone()]; // fallback: trata a pergunta como um único nó
    }

    // ── Fase 2: recolher factos por sub-pergunta (Self-Ask, conduzido pelo andaime) ───────
    let mut evidence = String::new();
    let mut fetches = 0usize;
    for sq in &subqs {
        on_tool("web_search", sq);
        let results = web::web_search(provider, api_key, sq, 5).await.unwrap_or_default();
        collect_sources(&mut sources, &results);
        evidence.push_str(&format!("### {sq}\n"));
        if results.is_empty() {
            evidence.push_str("(sem resultados de pesquisa)\n\n");
            continue;
        }
        evidence.push_str(&truncate(&web::format_results(&results), 1200));
        // Abre a melhor página para detalhe (limitado no total).
        if fetches < MAX_FETCH {
            if let Some(top) = results.first() {
                on_tool("web_fetch", &top.url);
                if let Ok(page) = web::web_fetch(&top.url).await {
                    fetches += 1;
                    evidence.push_str(&format!("\n\n[Conteúdo de {}]\n{}", top.url, truncate(&page, 1500)));
                }
            }
        }
        evidence.push_str("\n\n");
    }

    // ── Fase 3: verificar afirmações voláteis (Chain-of-Verification) ─────────────────────
    let n_verify = (max_rounds as usize).min(4);
    if n_verify > 0 {
        on_tool("research", "verify");
        let verify_sys = format!(
            "Hoje é {today}. Com base nas EVIDÊNCIAS recolhidas, gera perguntas de verificação CURTAS e \
específicas sobre afirmações que possam estar desatualizadas ou ser suposições (ex.: 'qual é o X mais \
recente em {year}?', 'confirma o preço/data atual de Y'). Responde APENAS com um array JSON de strings."
        );
        let vuser = format!(
            "Pergunta original: {question}\n\nEvidências:\n{}",
            truncate(&evidence, 6000)
        );
        let vz = ask(endpoint, model, &verify_sys, &vuser, opts).await?;
        total_in += vz.input_tokens;
        total_out += vz.output_tokens;
        for vq in parse_json_array(&vz.text).into_iter().take(n_verify) {
            on_tool("web_search", &vq);
            let results = web::web_search(provider, api_key, &vq, 4).await.unwrap_or_default();
            collect_sources(&mut sources, &results);
            if !results.is_empty() {
                evidence.push_str(&format!(
                    "### Verificação: {vq}\n{}\n\n",
                    truncate(&web::format_results(&results), 800)
                ));
            }
        }
    }

    // ── Fase 4: sintetizar SÓ a partir das evidências (streaming) ─────────────────────────
    on_tool("research", "synthesize");
    let evidence = truncate(&evidence, EVIDENCE_CAP);
    let synth_sys = format!(
        "Hoje é {today}. Recebeste EVIDÊNCIAS de pesquisa web para responder à pergunta do utilizador. \
Escreve a resposta final em Markdown, baseada SÓ nas evidências — não acrescentes factos da tua memória. \
Dá prioridade à informação ATUAL ({year}); se as evidências contradisserem o teu conhecimento prévio, segue \
as evidências. NÃO inventes preços, números nem URLs. NÃO acrescentes secção de fontes (é adicionada \
automaticamente).\n\nSê CONCISO e direto: estrutura com títulos curtos e listas, dá valores/gamas concretos \
quando existirem, e responde ao essencial. NÃO repitas ressalvas nem encha — algumas centenas de palavras \
chegam. Se faltar um dado, di-lo numa linha e segue em frente."
    );
    let synth_user = format!("Pergunta:\n{question}\n\nEvidências recolhidas:\n{evidence}");
    let synth_msgs = vec![msg("system", synth_sys), msg("user", synth_user)];
    // Janela = prompt (estimado com folga p/ PT) + orçamento de resposta; teto na VRAM.
    const ANSWER_BUDGET: u32 = 4096; // teto de tokens da resposta (num_predict)
    let prompt_tok = ((evidence.chars().count() + question.chars().count()) as f64 / 4.0 * 1.3) as u32 + 512;
    let synth_opts = GenOpts {
        num_ctx: (prompt_tok + ANSWER_BUDGET + 512).clamp(opts.num_ctx, 32768),
        num_predict: Some(ANSWER_BUDGET as i32),
        ..opts
    };
    let resp = ollama::chat_stream(
        endpoint,
        model,
        &synth_msgs,
        synth_opts,
        false,
        |d| on_delta(d),
        |_| {},
    )
    .await?;
    total_in += resp.input_tokens;
    total_out += resp.output_tokens;
    let mut final_text = resp.text;

    // Fontes acumuladas.
    if !sources.is_empty() {
        let mut f = String::from("\n\n## Fontes\n");
        for (i, (title, url)) in sources.iter().enumerate() {
            let label = if title.trim().is_empty() { url } else { title };
            f.push_str(&format!("{}. [{}]({})\n", i + 1, label, url));
        }
        on_delta(&f);
        final_text.push_str(&f);
    }

    Ok(LlmResponse {
        text: final_text,
        input_tokens: total_in,
        output_tokens: total_out,
        reported_cost_usd: 0.0,
        sources: Vec::new(),
    })
}
