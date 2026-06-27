//! Loop de tool-calling para o modelo LOCAL (Ollama): expõe `web_search`/`web_fetch`
//! e deixa o modelo pesquisar a net, à imagem do `agent.rs` do Claude. Resposta final
//! emitida de uma vez (não-stream por turno), com secção "## Fontes" no fim.

use anyhow::Result;
use serde_json::{json, Value};

use crate::providers::ollama::{self, GenOpts};
use crate::providers::{ChatMessage, LlmResponse};
use crate::tools::web;

const MAX_TURNS: usize = 5;

const SYSTEM: &str = "Tens acesso à web. Para acontecimentos atuais, datas, tempo/meteorologia, \
notícias, preços ou resultados, chama SEMPRE web_search primeiro (e web_fetch para ler um resultado em \
detalhe). Pesquisa sempre informação ATUAL (usa a data de hoje, não anos antigos). Responde APENAS com \
base nos resultados da pesquisa; se não encontrares, di-lo claramente. NUNCA inventes URLs, datas, \
números nem factos. Se te pedirem um PDF/documento, NÃO procures um PDF na web — escreve o documento \
num bloco ```markdown (aparece como artefacto) e diz ao utilizador para clicar em 'Export PDF'. Sê conciso.";

fn tools_schema() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "Pesquisa na web. Devolve títulos, URLs e excertos. Usa quando precisares de informação atual ou externa.",
                "parameters": {
                    "type": "object",
                    "properties": { "query": { "type": "string", "description": "o que pesquisar" } },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "web_fetch",
                "description": "Busca o texto de uma página web por URL (para ler em detalhe um resultado).",
                "parameters": {
                    "type": "object",
                    "properties": { "url": { "type": "string" } },
                    "required": ["url"]
                }
            }
        }
    ])
}

/// `on_delta` recebe o texto final; `on_tool` recebe (nome, detalhe) de cada pesquisa.
pub async fn run<D, T>(
    endpoint: &str,
    model: &str,
    provider: &str,
    api_key: &str,
    full_messages: &[ChatMessage],
    opts: GenOpts,
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let sys = format!("Hoje é {}. {SYSTEM}", chrono::Local::now().format("%Y-%m-%d"));
    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": sys })];
    messages.extend(full_messages.iter().map(|m| {
        // Preserva imagens anexadas (Ollama: campo `images` por mensagem) para modelos com visão.
        let imgs: Vec<&str> = m
            .attachments
            .iter()
            .filter(|a| a.kind == "image")
            .map(|a| a.data_base64.as_str())
            .collect();
        if imgs.is_empty() {
            json!({ "role": m.role, "content": m.content })
        } else {
            json!({ "role": m.role, "content": m.content, "images": imgs })
        }
    }));
    let tools = tools_schema();

    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut final_text = String::new();
    let mut sources: Vec<(String, String)> = Vec::new(); // (title, url)

    for _ in 0..MAX_TURNS {
        let resp = ollama::chat_raw(endpoint, model, json!(messages), Some(tools.clone()), opts).await?;
        total_in += resp.get("prompt_eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
        total_out += resp.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0);

        let msg = resp.get("message").cloned().unwrap_or_else(|| json!({}));
        let tool_calls = msg
            .get("tool_calls")
            .and_then(|x| x.as_array())
            .cloned()
            .unwrap_or_default();

        if tool_calls.is_empty() {
            if let Some(c) = msg.get("content").and_then(|x| x.as_str()) {
                on_delta(c);
                final_text.push_str(c);
            }
            break;
        }

        messages.push(msg.clone());
        for tc in &tool_calls {
            let func = tc.get("function").cloned().unwrap_or_else(|| json!({}));
            let name = func.get("name").and_then(|x| x.as_str()).unwrap_or("");
            let raw_args = func.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let args = match raw_args.as_str() {
                Some(s) => serde_json::from_str::<Value>(s).unwrap_or_else(|_| json!({})),
                None => raw_args,
            };
            let result = match name {
                "web_search" => {
                    let q = args.get("query").and_then(|x| x.as_str()).unwrap_or("");
                    on_tool("web_search", q);
                    match web::web_search(provider, api_key, q, 5).await {
                        Ok(rs) if !rs.is_empty() => {
                            for r in &rs {
                                if !r.url.is_empty() && !sources.iter().any(|(_, u)| u == &r.url) {
                                    sources.push((r.title.clone(), r.url.clone()));
                                }
                            }
                            web::format_results(&rs)
                        }
                        // Sem resultados: dá uma instrução acionável em vez de um beco sem saída.
                        Ok(_) if provider == "duckduckgo" || provider.is_empty() => {
                            "A pesquisa (DuckDuckGo, sem chave) não devolveu resultados desta vez — \
pode ter sido limite de ritmo (o DuckDuckGo trava rajadas) ou termos sem correspondência. Tenta de \
novo com termos diferentes; se falhar repetidamente, sugere ao utilizador adicionar uma chave (Tavily/\
Brave/…) em Modelos → Avançado para maior fiabilidade. Não inventes resultados nem finjas que pesquisaste."
                                .to_string()
                        }
                        Ok(_) => format!(
                            "Sem resultados de '{provider}'. Tenta termos diferentes ou verifica a chave \
do motor em Modelos → Avançado. Não inventes resultados."
                        ),
                        Err(e) => format!("erro na pesquisa: {e}"),
                    }
                }
                "web_fetch" => {
                    let u = args.get("url").and_then(|x| x.as_str()).unwrap_or("");
                    on_tool("web_fetch", u);
                    web::web_fetch(u).await.unwrap_or_else(|e| format!("erro: {e}"))
                }
                other => format!("ferramenta desconhecida: {other}"),
            };
            messages.push(json!({ "role": "tool", "content": result }));
        }
    }

    // Se esgotou os turnos sem texto final, força uma resposta sem ferramentas.
    if final_text.trim().is_empty() {
        if let Ok(resp) = ollama::chat_raw(endpoint, model, json!(messages), None, opts).await {
            total_in += resp.get("prompt_eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
            total_out += resp.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
            if let Some(c) = resp.pointer("/message/content").and_then(|x| x.as_str()) {
                on_delta(c);
                final_text.push_str(c);
            }
        }
    }

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
