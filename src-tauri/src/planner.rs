//! Plan mode ("planeamento profundo"): o modelo rascunha um plano de passos ACIONÁVEIS, o
//! utilizador aprova/edita/rejeita, e o andaime executa cada passo em sequência (raciocínio/
//! escrita, opcionalmente fundamentado na web quando o 🔎 está ligado). Irmão do `deep_research`:
//! o código orquestra os passos; o modelo só preenche o conteúdo de cada um.

use anyhow::Result;

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

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        s.chars().take(max).collect::<String>() + "…"
    }
}

/// Extrai o primeiro array JSON de strings (robusto a texto à volta).
fn parse_steps(text: &str) -> Vec<String> {
    let (Some(a), Some(b)) = (text.find('['), text.rfind(']')) else {
        return Vec::new();
    };
    if b < a {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(&text[a..=b])
        .unwrap_or_default()
        .into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

/// Plan mode. `approve(draft)` emite o plano à UI e devolve `None` (rejeitado) ou os passos
/// (possivelmente editados). `on_step(i, status)`, `on_delta(texto)`, `on_tool(nome, detalhe)`.
#[allow(clippy::too_many_arguments)]
pub async fn run<A, F, S, D, T>(
    settings: &Settings,
    use_api: bool,
    model: &str,
    messages: &[ChatMessage],
    opts: GenOpts,
    research: bool,
    approve: A,
    mut on_step: S,
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    A: FnOnce(Vec<String>) -> F,
    F: std::future::Future<Output = Option<Vec<String>>>,
    S: FnMut(usize, &str),
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let task = last_user(messages);
    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut sources: Vec<(String, String)> = Vec::new();

    // Chamada one-shot (texto limpo) — local sem thinking, ou Claude.
    let one_shot = |sys: String, user: String, opts: GenOpts| async move {
        if use_api {
            claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens,
                &[msg("system", sys), msg("user", user)], false).await
        } else {
            ollama::chat_stream(&settings.ollama_endpoint, model, &[msg("system", sys), msg("user", user)],
                opts, false, |_| {}, |_| {}).await
        }
    };

    // ── Fase 1: planear ───────────────────────────────────────────────────────────────────
    on_tool("plan", "draft");
    let plan_sys = format!(
        "Hoje é {today}. És um planeador. Divide a tarefa do utilizador num PLANO de 3 a 7 passos \
ACIONÁVEIS e ordenados — cada passo um título curto e claro do que vai produzir/fazer. Pensa nas \
dependências (passos cedo preparam os tardios). Responde APENAS com um array JSON de strings (os passos), \
nada mais."
    );
    let plan_opts = GenOpts { num_predict: Some(1024), ..opts };
    let dz = one_shot(plan_sys, task.clone(), plan_opts).await?;
    total_in += dz.input_tokens;
    total_out += dz.output_tokens;
    let mut draft = parse_steps(&dz.text);
    draft.truncate(MAX_STEPS);
    if draft.is_empty() {
        draft = vec![task.clone()]; // fallback: um único passo
    }

    // ── Fase 2: aprovar / editar / rejeitar ─────────────────────────────────────────────────
    let steps = match approve(draft).await {
        Some(s) if !s.is_empty() => s,
        _ => {
            let txt = "Plano rejeitado.".to_string();
            on_delta(&txt);
            return Ok(LlmResponse { text: txt, input_tokens: total_in, output_tokens: total_out, reported_cost_usd: 0.0, sources: Vec::new() });
        }
    };

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

    for (i, step) in steps.iter().enumerate() {
        on_step(i, "executing");
        let heading = format!("\n\n## {}. {step}\n", i + 1);
        on_delta(&heading);
        final_text.push_str(&heading);

        // Grounding leve (só excertos) quando o 🔎 está ligado.
        let mut evidence = String::new();
        if research {
            on_tool("web_search", step);
            let results = web::web_search(&settings.web_search_provider, &settings.active_web_key(), step, 3)
                .await
                .unwrap_or_default();
            for r in &results {
                if !r.url.is_empty() && !sources.iter().any(|(_, u)| u == &r.url) {
                    sources.push((r.title.clone(), r.url.clone()));
                }
            }
            if !results.is_empty() {
                evidence = format!("\n\nEvidências da web (usa-as; não inventes):\n{}", truncate(&web::format_results(&results), 1200));
            }
        }

        let step_sys = format!(
            "Hoje é {today}. Estás a EXECUTAR um plano para a tarefa:\n{task}\n\nPlano completo:\n{plan_list}\n\n\
Já produziste (resumo):\n{}\n\nExecuta AGORA só o passo {}: «{step}». Produz o resultado em Markdown, conciso \
e concreto. NÃO repitas o plano nem os passos anteriores. Se algo precisar de dados que não tens, di-lo numa \
linha.{evidence}",
            truncate(&prior, PRIOR_CAP),
            i + 1
        );
        let out = if use_api {
            let r = claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens,
                &[msg("system", step_sys), msg("user", format!("Passo {}.", i + 1))], false).await;
            match r {
                Ok(resp) => { on_delta(&resp.text); resp }
                Err(e) => { on_step(i, "error"); on_delta(&format!("(falha: {e})")); continue; }
            }
        } else {
            let r = ollama::chat_stream(&settings.ollama_endpoint, model,
                &[msg("system", step_sys), msg("user", format!("Passo {}.", i + 1))],
                step_opts, false, |d| on_delta(d), |_| {}).await;
            match r {
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
