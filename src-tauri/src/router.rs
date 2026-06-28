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

/// Deteta, pelo nome, se um modelo Ollama lê imagens (espelha `modelCapabilities` no frontend).
/// Evita uma chamada extra a `/api/show`; cobre as famílias multimodais comuns.
fn model_supports_vision(name: &str) -> bool {
    let n = name.to_lowercase();
    n.contains("vision") // llama3.2-vision, granite-vision, …
        || n.contains("llava")
        || n.contains("moondream")
        || n.contains("minicpm-v")
        || n.contains("gemma4")
        || n.contains("-vl")
        || n.contains("vl:")
        || n.ends_with("vl")
        || n.contains("gemma3:4b")
        || n.contains("gemma3:12b")
        || n.contains("gemma3:27b")
}

/// Injeta o texto dos documentos anexados no conteúdo da mensagem. Devolve uma cópia
/// das mensagens com o preâmbulo do documento à frente do texto do utilizador; as
/// imagens ficam intactas (seguem para a visão). Mensagens sem documentos são copiadas tal e qual.
fn fold_documents(messages: &[ChatMessage]) -> Vec<ChatMessage> {
    messages
        .iter()
        .map(|m| {
            let docs: Vec<&crate::providers::Attachment> =
                m.attachments.iter().filter(|a| a.kind == "document").collect();
            if docs.is_empty() {
                return m.clone();
            }
            let mut preamble = String::new();
            for d in &docs {
                let name = if d.name.is_empty() { "documento" } else { &d.name };
                preamble.push_str(&format!("[Documento anexado: {name}]\n{}\n\n", d.text));
            }
            ChatMessage {
                role: m.role.clone(),
                content: format!("{preamble}{}", m.content),
                attachments: m.attachments.clone(),
            }
        })
        .collect()
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
    match providers::ollama::generate(&settings.ollama_endpoint, &settings.ollama_model, &q, gopts(settings)).await {
        Ok(resp) if !resp.text.trim().is_empty() => resp.text,
        _ => raw.to_string(), // fallback: sem compressão
    }
}

/// Resume um transcript de conversa com o modelo local (para o /compact da Saga).
/// Devolve `None` se o transcript estiver vazio ou o modelo falhar.
pub async fn summarize_conversation(transcript: &str, settings: &Settings) -> Option<String> {
    if transcript.trim().is_empty() {
        return None;
    }
    let q = format!(
        "Resume a conversa seguinte de forma concisa mas completa, em pontos. Preserva factos, \
decisões, nomes, caminhos de ficheiros, números e o estado atual da tarefa, para servir de contexto \
à continuação. Escreve no idioma da conversa. NÃO inventes nada.\n\n{transcript}"
    );
    match providers::ollama::generate(
        &settings.ollama_endpoint,
        &settings.ollama_model,
        &q,
        gopts(settings),
    )
    .await
    {
        Ok(resp) if !resp.text.trim().is_empty() => Some(resp.text.trim().to_string()),
        _ => None,
    }
}

pub struct Outcome {
    pub route: Route,
    pub model: String,
    pub response: LlmResponse,
    pub reason: String,
    pub tokens_saved_compression: u64,
}

const WORKSPACE_NUDGE: &str = "Para criar ou editar skills, playbooks ou workflows, NÃO escrevas \
ficheiros nem uses uma pasta .claude/ — usa o comando /skill (ou /playbook, /workflow), ou o botão \
'Gerar com IA' no Workspace da Saga.";

/// Para a rota local: como criar um PDF (não há ferramenta de PDF local).
const PDF_NUDGE: &str = "\n\nSe te pedirem um PDF ou documento, NÃO procures um PDF na web: escreve o \
documento completo num bloco de código ```markdown (aparece como artefacto) e diz ao utilizador para \
clicar em 'Export PDF' no painel do artefacto.";

/// Data de hoje, para o modelo não assumir um ano antigo do treino.
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn with_system(context: &str, messages: &[ChatMessage]) -> Vec<ChatMessage> {
    let mut out = Vec::with_capacity(messages.len() + 1);
    let mut sys = format!("Hoje é {}. Usa informação atual.\n\n{WORKSPACE_NUDGE}", today());
    if !context.trim().is_empty() {
        sys.push_str(&format!("\n\nContexto/memória relevante:\n{context}"));
    }
    out.push(ChatMessage {
        role: "system".into(),
        content: sys,
        attachments: Vec::new(),
    });
    out.extend_from_slice(messages);
    out
}

/// Opções de geração para a rota local, a partir das definições.
fn gopts(s: &Settings) -> providers::ollama::GenOpts {
    providers::ollama::GenOpts {
        num_ctx: s.ollama_num_ctx,
        temperature: s.ollama_temp_opt(),
        num_predict: None,
    }
}

const LOCAL_HONESTY: &str = "És um assistente local. Sê conciso e direto. NUNCA inventes factos, datas, \
URLs, números ou nomes. Se a pergunta precisar de informação atual/externa ou não tiveres a certeza, \
diz-o claramente — sugere ligar o 🔎 (pesquisa) ou escalar para o Claude. Não dês passos inventados.";

/// Mensagens para a rota local: instrução de honestidade + memória (crua, é grátis).
fn with_system_local(
    context: &str,
    skills: &[(String, String)],
    messages: &[ChatMessage],
) -> Vec<ChatMessage> {
    let mut sys = format!(
        "Hoje é {}. Usa informação atual e não assumas anos antigos.\n\n{LOCAL_HONESTY}{PDF_NUDGE}",
        today()
    );
    if !context.trim().is_empty() {
        sys.push_str(&format!("\n\nContexto/memória relevante:\n{context}"));
    }
    // Skills acionadas por trigger (rota local): instruções completas injetadas no system prompt.
    for (name, body) in skills {
        sys.push_str(&format!(
            "\n\n# Skill ativa: {name}\nO utilizador acionou esta skill. Segue estas instruções:\n{body}"
        ));
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
    /// Skills acionadas por trigger nesta rota local (nomes) — para mostrar no chat e deduplicar
    /// o manifesto do `web_agent`. Vazio na rota Claude.
    pub skills_applied: Vec<String>,
}

/// Decide a rota, carrega memória e monta as mensagens finais (com compressão se escalar).
/// NÃO chama o provedor — isso fica para quem orquestra (stream ou não-stream).
pub async fn prepare(
    messages: &[ChatMessage],
    settings: &Settings,
    route_override: Option<&str>,
    model_override: Option<&str>,
) -> Result<Prepared> {
    // Só imagens forçam o caminho de visão; documentos são texto e seguem o caminho normal.
    // `has_images` (qualquer mensagem): usado para a decisão Claude-API (precisa de enviar as imagens).
    let has_images = messages
        .iter()
        .any(|m| m.attachments.iter().any(|a| a.kind == "image"));
    // `latest_has_image`: só o turno ATUAL conta para escolher o modelo de visão local — senão uma
    // imagem antiga arrastava todos os turnos seguintes (texto/docs) para o modelo de visão (e podia
    // ficar refém de um vision model que nem carrega, ex.: mllama → 500).
    let latest_has_image = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.attachments.iter().any(|a| a.kind == "image"))
        .unwrap_or(false);
    // Dobra o texto dos documentos anexados no conteúdo da mensagem (uma só vez, aqui no
    // router; a persistência guarda o conteúdo original, sem o preâmbulo).
    let folded = fold_documents(messages);
    let messages = &folded[..];

    // Local-first: corre no modelo local, exceto quando o utilizador escala explicitamente para o Claude.
    let (route, reason) = if route_override == Some("claude") {
        (Route::Claude, "escalado para o Claude".to_string())
    } else {
        (Route::Local, "modelo local".to_string())
    };

    let raw_memory = memory::load_raw(settings);

    match route {
        Route::Local => {
            let model = model_override.map(str::to_string).unwrap_or_else(|| {
                // Só troca para o modelo de visão se o turno ATUAL traz imagem e o modelo ativo NÃO vê
                // (ex.: gemma4 já tem visão → usa-o em vez de exigir o llama3.2-vision).
                if latest_has_image
                    && !model_supports_vision(&settings.ollama_model)
                    && !settings.ollama_vision_model.trim().is_empty()
                {
                    settings.ollama_vision_model.clone()
                } else {
                    settings.ollama_model.clone()
                }
            });
            // Skills acionadas por trigger na última mensagem do utilizador (rota local).
            let skills = if settings.workspace_dir.trim().is_empty() {
                Vec::new()
            } else {
                let last_user = messages
                    .iter()
                    .rev()
                    .find(|m| m.role == "user")
                    .map(|m| m.content.as_str())
                    .unwrap_or("");
                crate::workspace::triggered_skills(&settings.workspace_dir, last_user)
            };
            let skills_applied = skills.iter().map(|(n, _)| n.clone()).collect();
            Ok(Prepared {
                route: Route::Local,
                model,
                // Honestidade + memória crua (local é grátis, sem compressão).
                full_messages: with_system_local(&raw_memory, &skills, messages),
                tokens_saved: 0,
                reason,
                has_images,
                skills_applied,
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
                skills_applied: Vec::new(),
            })
        }
    }
}

/// Orquestra um pedido completo (não-streaming): prepara + chama o provedor.
pub async fn handle(messages: &[ChatMessage], settings: &Settings) -> Result<Outcome> {
    let p = prepare(messages, settings, None, None).await?;

    let response = match p.route {
        Route::Local => {
            providers::ollama::chat(&settings.ollama_endpoint, &p.model, &p.full_messages, gopts(settings)).await?
        }
        Route::Claude => {
            // CLI e API leem imagens (a CLI via ficheiros temporários + tool Read).
            let use_api = settings.claude_mode == "api";
            if use_api {
                providers::claude_api::messages(
                    &settings.claude_api_key,
                    &p.model,
                    settings.claude_max_tokens,
                    &p.full_messages,
                    false,
                )
                .await?
            } else {
                providers::claude_cli::run(
                    &settings.claude_cli_path,
                    &p.model,
                    &p.full_messages,
                    &[],
                )
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
