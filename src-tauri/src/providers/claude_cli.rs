//! Provedor Claude via subprocess da Claude CLI (`claude -p ... --output-format json`).
//! Reaproveita a subscrição/autenticação local da Claude Code; não precisa de API key.

use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command;

use super::{Attachment, ChatMessage, LlmResponse};

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

/// Extensão a partir do media type da imagem.
fn img_ext(media_type: &str) -> &'static str {
    match media_type {
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        _ => "png",
    }
}

/// Escreve uma imagem (base64) num ficheiro temporário e devolve o caminho.
fn write_temp_image(dir: &std::path::Path, idx: usize, a: &Attachment) -> Option<PathBuf> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(a.data_base64.trim())
        .ok()?;
    std::fs::create_dir_all(dir).ok()?;
    let path = dir.join(format!("img-{idx}.{}", img_ext(&a.media_type)));
    std::fs::write(&path, bytes).ok()?;
    Some(path)
}

/// Compacta a conversa num único prompt (a CLI recebe um prompt, não um array).
/// As imagens são escritas em ficheiros temporários e referenciadas pelo caminho — a CLI lê-as
/// com a tool Read (passamos `--allowedTools Read`). Devolve (prompt, ficheiros temporários).
fn flatten(messages: &[ChatMessage], tmp_dir: &std::path::Path) -> (String, Vec<PathBuf>) {
    let mut out = String::new();
    let mut tmp_files: Vec<PathBuf> = Vec::new();
    for m in messages {
        let label = match m.role.as_str() {
            "system" => "[contexto]",
            "assistant" => "Assistente:",
            _ => "Utilizador:",
        };
        out.push_str(&format!("{label} {}", m.content));
        // Anexa as imagens desta mensagem (caminho com barras normais; a Read aceita ambas).
        for a in m.attachments.iter().filter(|a| a.kind == "image" && !a.data_base64.is_empty()) {
            if let Some(p) = write_temp_image(tmp_dir, tmp_files.len(), a) {
                let path = p.to_string_lossy().replace('\\', "/");
                out.push_str(&format!("\n[imagem anexada — lê o ficheiro: {path}]"));
                tmp_files.push(p);
            }
        }
        out.push_str("\n\n");
    }
    (out, tmp_files)
}

pub async fn run(
    cli_path: &str,
    model: &str,
    messages: &[ChatMessage],
    allowed_tools: &[&str],
) -> Result<LlmResponse> {
    // Imagens vão para ficheiros temporários referenciados no prompt (a CLI lê-as via Read).
    let tmp_dir = std::env::temp_dir().join("saga-cli-images");
    let (prompt, tmp_files) = flatten(messages, &tmp_dir);
    let has_images = !tmp_files.is_empty();
    let cli_path = cli_path.to_string();
    let model = model.to_string();

    let mut tools: Vec<String> = allowed_tools.iter().map(|s| s.to_string()).collect();
    if has_images && !tools.iter().any(|t| t == "Read") {
        tools.push("Read".into()); // necessário para a CLI conseguir abrir as imagens
    }

    // O prompt vai por STDIN (não como argumento): conversas grandes excediam o limite da linha
    // de comandos do Windows (os error 206 "filename or extension is too long").
    let mut args: Vec<String> = vec![
        "-p".into(),
        "--output-format".into(),
        "json".into(),
        "--model".into(),
        model,
    ];
    if !tools.is_empty() {
        // Autoriza ferramentas da CLI em modo headless (senão pede permissão).
        args.push("--allowedTools".into());
        args.push(tools.join(","));
    }

    let path_msg = cli_path.clone();
    // Command é síncrono — corre num thread de blocking para não travar o runtime async.
    let output = tauri::async_runtime::spawn_blocking(move || -> std::io::Result<std::process::Output> {
        use std::io::Write;
        use std::process::Stdio;
        #[allow(unused_mut)]
        let mut builder = Command::new(&cli_path);
        builder
            .args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            builder.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = builder.spawn()?;
        // Escreve o prompt e fecha o stdin (a CLI lê tudo até EOF antes de responder).
        if let Some(mut sin) = child.stdin.take() {
            sin.write_all(prompt.as_bytes())?;
        }
        child.wait_with_output()
    })
    .await
    .map_err(|e| anyhow!("falha a lançar a Claude CLI: {e}"))?
    .map_err(|e| {
        anyhow!(
            "Claude CLI não encontrada ('{path_msg}'): {e}. Instala a Claude CLI, ou muda o cloud para \
modo API em Definições/Modelos. (O modelo local continua a funcionar.)"
        )
    })?;

    // A CLI já terminou (leu as imagens) — limpa os ficheiros temporários.
    for p in &tmp_files {
        let _ = std::fs::remove_file(p);
    }

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
        sources: Vec::new(),
    })
}
