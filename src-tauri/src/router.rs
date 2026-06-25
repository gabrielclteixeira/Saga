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

/// Triagem: o modelo local decide quem responde, ANTES de responder. Falha → None.
async fn classify_local(prompt: &str, settings: &Settings) -> Option<Route> {
    let q = format!(
        "És um triador de pedidos. Decide quem deve responder ao pedido abaixo. \
Responde APENAS com uma palavra: LOCAL (se é simples — leitura, resumo, reformulação, tradução — \
e podes responder de forma fiável e factual) ou CLAUDE (se precisa de raciocínio complexo, código, \
conhecimento externo/atualizado, ou passos específicos de um produto/serviço). \
Na dúvida, responde CLAUDE.\n\nPedido: {prompt}"
    );
    let resp = providers::ollama::generate(&settings.ollama_endpoint, &settings.ollama_model, &q)
        .await
        .ok()?;
    let answer = resp.text.to_uppercase();
    // "na dúvida → CLAUDE": só fica local se disser LOCAL e não disser CLAUDE.
    if answer.contains("CLAUDE") {
        Some(Route::Claude)
    } else if answer.contains("LOCAL") {
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

const LOCAL_HONESTY: &str = "És um assistente local pequeno. Se não tiveres a certeza, \
ou se a pergunta precisar de informação externa/atualizada ou de passos específicos de um produto/serviço, \
diz claramente que não tens a certeza e sugere escalar para o Claude. \
NUNCA inventes passos, factos, nomes ou definições.";

/// Mensagens para a rota local: instrução de honestidade + memória (crua, é grátis).
fn with_system_local(context: &str, messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut sys = LOCAL_HONESTY.to_string();
    if !context.trim().is_empty() {
        sys.push_str(&format!("\n\nContexto/memória relevante:\n{context}"));
    }
    let mut out = Vec::with_capacity(messages.len() + 1);
    out.push(ChatMessage {
        role: "system".into(),
        content: sys,
        attachments: Vec::new(),
    });
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
pub async fn prepare(
    messages: &[ChatMessage],
    settings: &Settings,
    route_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<Prepared> {
    let prompt = last_user_prompt(messages);
    let has_images = messages.iter().any(|m| !m.attachments.is_empty());

    // 1. Rota: override do utilizador > intenção/triagem.
    let (route, reason) = if let Some(r) = route_override {
        let route = if r == "claude" {
            Route::Claude
        } else {
            Route::Local
        };
        (route, "forçado pelo utilizador".to_string())
    } else {
        let mut decision = decide(&prompt, settings);
        // Triagem é o sinal principal (override do comprimento) quando ativa.
        if !decision.firm && settings.routing.use_local_classifier {
            if let Some(r) = classify_local(&prompt, settings).await {
                decision.reason = format!("triagem local → {}", r.as_str());
                decision.route = r;
            }
        }
        (decision.route, decision.reason)
    };

    let raw_memory = memory::load_raw(settings);

    match route {
        Route::Local => {
            let model = model_override.map(str::to_string).unwrap_or_else(|| {
                if has_images && !settings.ollama_vision_model.trim().is_empty() {
                    settings.ollama_vision_model.clone()
                } else {
                    settings.ollama_model.clone()
                }
            });
            Ok(Prepared {
                route: Route::Local,
                model,
                // Honestidade + memória crua (local é grátis, sem compressão).
                full_messages: with_system_local(&raw_memory, messages),
                tokens_saved: 0,
                reason,
                has_images,
            })
        }
        Route::Claude => {
            let model = model_override
                .map(str::to_string)
                .unwrap_or_else(|| settings.claude_model.clone());
            // Comprime a memória antes de escalar → menos tokens pagos.
            let compressed = compress_context(&raw_memory, settings).await;
            let saved = estimate_tokens(&raw_memory).saturating_sub(estimate_tokens(&compressed));
            Ok(Prepared {
                route: Route::Claude,
                model,
                full_messages: with_system(&compressed, messages),
                tokens_saved: saved,
                reason,
                has_images,
            })
        }
    }
}

/// Orquestra um pedido completo (não-streaming): prepara + chama o provedor.
pub async fn handle(messages: &[ChatMessage], settings: &Settings) -> Result<Outcome> {
    let p = prepare(messages, settings, None, None).await?;

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
