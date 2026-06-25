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
            attachments: Vec::new(),
        });
    }
    out.extend_from_slice(messages);
    out
}

/// Resultado da fase de decisão+preparação, partilhado pelos caminhos stream e não-stream.
pub struct Prepared {
    pub route: Route,
    pub model: String,
    pub full_messages: Vec<ChatMessage>,
    pub tokens_saved: u64,
    pub reason: String,
    /// Há imagens anexadas → exige API (Claude) ou modelo de visão (local).
    pub has_images: bool,
}

/// Decide a rota, carrega memória e monta as mensagens finais (com compressão se escalar).
/// NÃO chama o provedor — isso fica para quem orquestra (stream ou não-stream).
pub async fn prepare(messages: &[ChatMessage], settings: &Settings) -> Result<Prepared> {
    let prompt = last_user_prompt(messages);

    let mut decision = decide(&prompt, settings);
    if !decision.firm && settings.routing.use_local_classifier {
        if let Some(route) = classify_local(&prompt, settings).await {
            decision.reason = format!("classificador local → {}", route.as_str());
            decision.route = route;
        }
    }

    let has_images = messages.iter().any(|m| !m.attachments.is_empty());
    let raw_memory = memory::load_raw(settings);

    match decision.route {
        Route::Local => {
            // Com imagens, usa o modelo de visão local (fallback para o normal se vazio).
            let model = if has_images && !settings.ollama_vision_model.trim().is_empty() {
                settings.ollama_vision_model.clone()
            } else {
                settings.ollama_model.clone()
            };
            Ok(Prepared {
                route: Route::Local,
                model,
                // Local é gratuito → injeta a memória crua (sem compressão).
                full_messages: with_system(&raw_memory, messages),
                tokens_saved: 0,
                reason: decision.reason,
                has_images,
            })
        }
        Route::Claude => {
            // Comprime a memória antes de escalar → menos tokens pagos.
            let compressed = compress_context(&raw_memory, settings).await;
            let saved =
                estimate_tokens(&raw_memory).saturating_sub(estimate_tokens(&compressed));
            Ok(Prepared {
                route: Route::Claude,
                model: settings.claude_model.clone(),
                full_messages: with_system(&compressed, messages),
                tokens_saved: saved,
                reason: decision.reason,
                has_images,
            })
        }
    }
}

/// Orquestra um pedido completo (não-streaming): prepara + chama o provedor.
pub async fn handle(messages: &[ChatMessage], settings: &Settings) -> Result<Outcome> {
    let p = prepare(messages, settings).await?;

    let response = match p.route {
        Route::Local => {
            providers::ollama::chat(&settings.ollama_endpoint, &p.model, &p.full_messages).await?
        }
        Route::Claude => {
            // Imagens exigem API (a CLI não as suporta).
            let use_api = p.has_images || settings.claude_mode == "api";
            if use_api {
                providers::claude_api::messages(
                    &settings.claude_api_key,
                    &p.model,
                    settings.claude_max_tokens,
                    &p.full_messages,
                )
                .await?
            } else {
                providers::claude_cli::run(&settings.claude_cli_path, &p.model, &p.full_messages)
                    .await?
            }
        }
    };

    Ok(Outcome {
        route: p.route,
        model: p.model,
        response,
        reason: p.reason,
        tokens_saved_compression: p.tokens_saved,
    })
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
