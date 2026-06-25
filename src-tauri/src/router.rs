//! Router local ↔ Claude. Decide se um pedido é servido pelo modelo local (barato)
//! ou escalado para o Claude, e comprime o contexto antes de escalar para poupar tokens.

use anyhow::Result;

use crate::providers::{self, estimate_tokens, ChatMessage, LlmResponse};
use crate::settings::Settings;
use crate::{accounting, memory};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    Local,
    Claude,
}

impl Route {
    pub fn as_str(&self) -> &'static str {
        match self {
            Route::Local => "local",
            Route::Claude => "claude",
        }
    }
}

pub struct Decision {
    pub route: Route,
    pub reason: String,
    /// `true` quando a decisão é definitiva (ex.: palavra-chave) e não deve ser revista pelo classificador.
    pub firm: bool,
}

/// Decisão heurística e síncrona, a partir do último prompt do utilizador.
pub fn decide(prompt: &str, settings: &Settings) -> Decision {
    let routing = &settings.routing;

    if !routing.enabled {
        let route = if settings.claude_enabled() {
            Route::Claude
        } else {
            Route::Local
        };
        return Decision {
            route,
            reason: "router desligado — destino por omissão".into(),
            firm: true,
        };
    }

    let lc = prompt.to_lowercase();

    if let Some(kw) = routing
        .force_claude_keywords
        .iter()
        .find(|k| lc.contains(k.as_str()))
    {
        return Decision {
            route: Route::Claude,
            reason: format!("palavra-chave \"{kw}\" → Claude"),
            firm: true,
        };
    }

    if let Some(kw) = routing
        .force_local_keywords
        .iter()
        .find(|k| lc.contains(k.as_str()))
    {
        return Decision {
            route: Route::Local,
            reason: format!("palavra-chave \"{kw}\" → local"),
            firm: true,
        };
    }

    if !settings.claude_enabled() {
        return Decision {
            route: Route::Local,
            reason: "Claude desativado → local".into(),
            firm: true,
        };
    }

    let len = prompt.chars().count();
    if len <= routing.light_max_chars {
        Decision {
            route: Route::Local,
            reason: format!("prompt curto ({len} chars) → local"),
            firm: false,
        }
    } else {
        Decision {
            route: Route::Claude,
            reason: format!("prompt longo ({len} chars) → Claude"),
            firm: false,
        }
    }
}

/// Usa o modelo local para classificar a dificuldade. Em caso de falha, devolve None.
async fn classify_local(prompt: &str, settings: &Settings) -> Option<Route> {
    let q = format!(
        "Classifica a dificuldade do seguinte pedido para um assistente. \
Responde APENAS com uma palavra: LEVE (tarefa simples, factual, de leitura/resumo) \
ou PESADO (raciocínio complexo, código, arquitetura).\n\nPedido: {prompt}"
    );
    let resp = providers::ollama::generate(&settings.ollama_endpoint, &settings.ollama_model, &q)
        .await
        .ok()?;
    let answer = resp.text.to_uppercase();
    if answer.contains("PESADO") {
        Some(Route::Claude)
    } else if answer.contains("LEVE") {
        Some(Route::Local)
    } else {
        None
    }
}

/// Comprime o contexto de memória via modelo local, para enviar menos tokens ao Claude.
async fn compress_context(raw: &str, settings: &Settings) -> String {
    if raw.trim().is_empty() {
        return String::new();
    }
    let q = format!(
        "Resume o seguinte contexto em pontos concisos, preservando factos, nomes, \
caminhos e decisões importantes. Sê telegráfico.\n\n{raw}"
    );
    match providers::ollama::generate(&settings.ollama_endpoint, &settings.ollama_model, &q).await {
        Ok(resp) if !resp.text.trim().is_empty() => resp.text,
        _ => raw.to_string(), // fallback: sem compressão
    }
}

pub struct Outcome {
    pub route: Route,
    pub model: String,
    pub response: LlmResponse,
    pub reason: String,
    pub tokens_saved_compression: u64,
}

fn last_user_prompt(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn with_system(context: &str, messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    if !context.trim().is_empty() {
        out.push(ChatMessage {
            role: "system".into(),
            content: format!("Contexto/memória relevante:\n{context}"),
        });
    }
    out.extend_from_slice(messages);
    out
}

/// Orquestra um pedido completo: decide rota, monta contexto, chama o provedor.
pub async fn handle(messages: &[ChatMessage], settings: &Settings) -> Result<Outcome> {
    let prompt = last_user_prompt(messages);

    // 1. Decisão
    let mut decision = decide(&prompt, settings);
    if !decision.firm && settings.routing.use_local_classifier {
        if let Some(route) = classify_local(&prompt, settings).await {
            decision.reason = format!("classificador local → {}", route.as_str());
            decision.route = route;
        }
    }

    let raw_memory = memory::load_raw(settings);

    match decision.route {
        Route::Local => {
            // Local é gratuito → injeta a memória crua (sem compressão).
            let full = with_system(&raw_memory, messages);
            let response = providers::ollama::chat(
                &settings.ollama_endpoint,
                &settings.ollama_model,
                &full,
            )
            .await?;
            Ok(Outcome {
                route: Route::Local,
                model: settings.ollama_model.clone(),
                response,
                reason: decision.reason,
                tokens_saved_compression: 0,
            })
        }
        Route::Claude => {
            // Comprime a memória antes de escalar → menos tokens pagos.
            let compressed = compress_context(&raw_memory, settings).await;
            let saved = estimate_tokens(&raw_memory)
                .saturating_sub(estimate_tokens(&compressed));
            let full = with_system(&compressed, messages);

            let response = match settings.claude_mode.as_str() {
                "api" => {
                    providers::claude_api::messages(
                        &settings.claude_api_key,
                        &settings.claude_model,
                        settings.claude_max_tokens,
                        &full,
                    )
                    .await?
                }
                _ => {
                    // "cli" (ou qualquer outro) → usa a Claude CLI
                    providers::claude_cli::run(
                        &settings.claude_cli_path,
                        &settings.claude_model,
                        &full,
                    )
                    .await?
                }
            };

            Ok(Outcome {
                route: Route::Claude,
                model: settings.claude_model.clone(),
                response,
                reason: decision.reason,
                tokens_saved_compression: saved,
            })
        }
    }
}

/// Snapshot de custo para um Outcome (usado pela contabilidade/UI).
pub fn outcome_cost(outcome: &Outcome) -> f64 {
    if outcome.route == Route::Claude {
        if outcome.response.reported_cost_usd > 0.0 {
            outcome.response.reported_cost_usd
        } else {
            accounting::cost_usd(
                &outcome.model,
                outcome.response.input_tokens,
                outcome.response.output_tokens,
            )
        }
    } else {
        0.0
    }
}
