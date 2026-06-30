//! Modos de raciocínio "esforçado" na rota local (Ollama), opt-in pela escala Think.
//! `verify` = self-consistency: amostra N respostas, mede a concordância (confiança) e sintetiza
//! a melhor. (debate vem no Passo 3.) Reusa `ollama::chat_raw` (amostrar) + `chat_stream` (resposta
//! final, streamed) + `ollama::embed` (concordância, modelo ativo — zero-setup).

use anyhow::{anyhow, Result};
use serde_json::{json, Value};

use crate::providers::ollama::{self, GenOpts};
use crate::providers::{ChatMessage, LlmResponse};

/// Converte as mensagens para o formato wire do Ollama (preserva imagens). Espelha o web_agent.
fn wire(messages: &[ChatMessage]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
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
        })
        .collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na * nb)
    }
}

/// Concordância média (cosseno par-a-par dos embeddings das amostras). None se indisponível.
async fn agreement(endpoint: &str, model: &str, cands: &[String]) -> Option<f32> {
    if cands.len() < 2 {
        return None;
    }
    let refs: Vec<&str> = cands.iter().map(|s| s.as_str()).collect();
    let embs = ollama::embed(endpoint, model, &refs).await.ok()?;
    if embs.len() < 2 {
        return None;
    }
    let (mut total, mut n) = (0.0f32, 0u32);
    for i in 0..embs.len() {
        for j in (i + 1)..embs.len() {
            total += cosine(&embs[i], &embs[j]);
            n += 1;
        }
    }
    (n > 0).then(|| (total / n as f32).clamp(0.0, 1.0))
}

/// Self-consistency: amostra `samples` respostas (temperaturas variadas), mede a concordância e
/// sintetiza a melhor resposta final (streamed). Devolve (resposta, confiança 0–1).
pub async fn self_consistency<D, T>(
    endpoint: &str,
    model: &str,
    messages: &[ChatMessage],
    opts: GenOpts,
    samples: usize,
    on_delta: D,
    mut on_tool: T,
) -> Result<(LlmResponse, Option<f32>)>
where
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    const TEMPS: [f32; 3] = [0.5, 0.7, 0.9];
    let wire_msgs = json!(wire(messages));
    let mut candidates: Vec<String> = Vec::new();
    let (mut tin, mut tout) = (0u64, 0u64);

    for i in 0..samples.max(2) {
        on_tool("think", &format!("amostra {}/{}", i + 1, samples.max(2)));
        let mut o = opts;
        o.temperature = Some(TEMPS[i % TEMPS.len()]);
        let resp = ollama::chat_raw(endpoint, model, wire_msgs.clone(), None, o).await?;
        tin += resp.get("prompt_eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
        tout += resp.get("eval_count").and_then(|x| x.as_u64()).unwrap_or(0);
        if let Some(c) = resp.pointer("/message/content").and_then(|x| x.as_str()) {
            if !c.trim().is_empty() {
                candidates.push(c.to_string());
            }
        }
    }
    if candidates.is_empty() {
        return Err(anyhow!("verify: nenhuma amostra produziu resposta"));
    }

    let confidence = agreement(endpoint, model, &candidates).await;

    // Síntese final (streamed): o modelo consolida as amostras numa só resposta.
    on_tool("think", "a sintetizar");
    let mut block = format!(
        "Foram geradas {} respostas independentes à pergunta acima:\n\n",
        candidates.len()
    );
    for (i, c) in candidates.iter().enumerate() {
        block.push_str(&format!("### Resposta {}\n{}\n\n", i + 1, c.trim()));
    }
    block.push_str(
        "Sintetiza a MELHOR resposta final: combina o que é consistente entre elas e descarta erros. \
Se discordarem num ponto, escolhe o mais fundamentado. Responde diretamente ao utilizador, sem \
mencionar este processo nem as 'respostas' acima.",
    );
    let mut synth = messages.to_vec();
    synth.push(ChatMessage {
        role: "user".into(),
        content: block,
        attachments: Vec::new(),
    });

    let final_resp = ollama::chat_stream(endpoint, model, &synth, opts, false, on_delta, |_| {}).await?;
    Ok((
        LlmResponse {
            text: final_resp.text,
            input_tokens: tin + final_resp.input_tokens,
            output_tokens: tout + final_resp.output_tokens,
            reported_cost_usd: 0.0,
            sources: Vec::new(),
        },
        confidence,
    ))
}
