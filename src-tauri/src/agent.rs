//! Loop de tool-use (agêntico) sobre a API Anthropic: o modelo decide chamar
//! ferramentas de browser até concluir a resposta.

use anyhow::Result;

use crate::providers::{claude_api, ChatMessage, LlmResponse};
use crate::tools::dispatch::ToolHost;

const MAX_TURNS: usize = 8;

/// Corre o loop. `on_delta` recebe o texto do assistente; `on_tool` recebe (nome, detalhe) de cada chamada.
pub async fn run<H, D, T>(
    api_key: &str,
    model: &str,
    max_tokens: u32,
    full_messages: &[ChatMessage],
    host: &mut H,
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    H: ToolHost,
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let (mut system, mut messages) = claude_api::to_request_messages(full_messages);
    if let Some(add) = host.system_addendum() {
        system = Some(match system {
            Some(s) => format!("{s}\n\n{add}"),
            None => add,
        });
    }
    let tools = host.schemas();

    let mut total_in = 0u64;
    let mut total_out = 0u64;
    let mut final_text = String::new();

    for _ in 0..MAX_TURNS {
        let mut body = serde_json::json!({
            "model": model,
            "max_tokens": max_tokens,
            "messages": messages,
            "tools": tools,
        });
        if let Some(sys) = &system {
            body["system"] = serde_json::json!(sys);
        }

        let resp = claude_api::raw_request(api_key, &body).await?;
        total_in += resp
            .pointer("/usage/input_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);
        total_out += resp
            .pointer("/usage/output_tokens")
            .and_then(|x| x.as_u64())
            .unwrap_or(0);

        let content = resp
            .get("content")
            .cloned()
            .unwrap_or_else(|| serde_json::json!([]));
        let stop = resp.get("stop_reason").and_then(|x| x.as_str()).unwrap_or("");

        let mut tool_results: Vec<serde_json::Value> = Vec::new();
        if let Some(blocks) = content.as_array() {
            for block in blocks {
                match block.get("type").and_then(|x| x.as_str()) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                            on_delta(t);
                            final_text.push_str(t);
                        }
                    }
                    Some("tool_use") => {
                        let id = block
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let name = block
                            .get("name")
                            .and_then(|x| x.as_str())
                            .unwrap_or("")
                            .to_string();
                        let input = block
                            .get("input")
                            .cloned()
                            .unwrap_or_else(|| serde_json::json!({}));
                        on_tool(&name, &input.to_string());
                        let result = host
                            .call(&name, &input)
                            .await
                            .unwrap_or_else(|e| format!("ERRO: {e}"));
                        tool_results.push(serde_json::json!({
                            "type": "tool_result",
                            "tool_use_id": id,
                            "content": result,
                        }));
                    }
                    _ => {}
                }
            }
        }

        // Regista o turno do assistente (incl. blocos tool_use) no histórico do pedido.
        messages.push(serde_json::json!({ "role": "assistant", "content": content }));

        if stop == "tool_use" && !tool_results.is_empty() {
            messages.push(serde_json::json!({ "role": "user", "content": tool_results }));
            continue;
        }
        break;
    }

    Ok(LlmResponse {
        text: final_text,
        input_tokens: total_in,
        output_tokens: total_out,
        reported_cost_usd: 0.0,
        sources: Vec::new(),
    })
}
