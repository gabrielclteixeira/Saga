//! Provedor Claude via subprocess da Claude CLI (`claude -p ... --output-format json`).
//! Reaproveita a subscrição/autenticação local da Claude Code; não precisa de API key.

use anyhow::{anyhow, Result};
use serde::Deserialize;
use std::process::Command;

use super::{ChatMessage, LlmResponse};

#[derive(Deserialize)]
struct CliResult {
    #[serde(default)]
    result: String,
    #[serde(default)]
    is_error: bool,
    #[serde(default)]
    total_cost_usd: f64,
    #[serde(default)]
    usage: Usage,
}

#[derive(Deserialize, Default)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
}

/// Compacta a conversa num único prompt (a CLI recebe um prompt, não um array).
fn flatten(messages: &[ChatMessage]) -> String {
    let mut out = String::new();
    for m in messages {
        match m.role.as_str() {
            "system" => out.push_str(&format!("[contexto]\n{}\n\n", m.content)),
            "assistant" => out.push_str(&format!("Assistente: {}\n\n", m.content)),
            _ => out.push_str(&format!("Utilizador: {}\n\n", m.content)),
        }
    }
    out
}

pub async fn run(
    cli_path: &str,
    model: &str,
    messages: &[ChatMessage],
) -> Result<LlmResponse> {
    let prompt = flatten(messages);
    let cli_path = cli_path.to_string();
    let model = model.to_string();

    // Command é síncrono — corre num thread de blocking para não travar o runtime async.
    let output = tauri::async_runtime::spawn_blocking(move || {
        Command::new(&cli_path)
            .arg("-p")
            .arg(&prompt)
            .arg("--output-format")
            .arg("json")
            .arg("--model")
            .arg(&model)
            .output()
    })
    .await
    .map_err(|e| anyhow!("falha a lançar a Claude CLI: {e}"))?
    .map_err(|e| anyhow!("falha a executar a Claude CLI: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("Claude CLI terminou com erro: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: CliResult = serde_json::from_str(stdout.trim())
        .map_err(|e| anyhow!("JSON da Claude CLI inválido: {e}; saída: {stdout}"))?;

    if parsed.is_error {
        return Err(anyhow!("Claude CLI reportou erro: {}", parsed.result));
    }

    Ok(LlmResponse {
        text: parsed.result,
        input_tokens: parsed.usage.input_tokens,
        output_tokens: parsed.usage.output_tokens,
        reported_cost_usd: parsed.total_cost_usd,
    })
}
