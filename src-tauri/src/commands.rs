//! Comandos Tauri expostos ao frontend.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use rusqlite::Connection;
use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tokio::sync::oneshot;

use crate::accounting::Accounting;
use crate::mcp::McpManager;
use crate::providers::{estimate_tokens, ChatMessage};
use crate::router;
use crate::settings::Settings;
use crate::store::{self, ConversationMeta, SearchHit, StoredMessage};
use crate::tools::browser::PlaywrightSidecar;
use crate::tools::dispatch::{ActionGate, ApprovalFut, Approver, ConfirmMode, Dispatcher};
use crate::{agent, memory, providers};

/// Calcula a janela de contexto efetiva para um pedido local.
///
/// No Ollama, `num_ctx` é a janela TOTAL (prompt + resposta). Com um prompt grande
/// (ex.: um PDF anexado), a janela fixa enche-se e quase não sobra espaço para a
/// resposta — o modelo pára a meio. Aqui subimos a janela para caber o prompt + uma
/// folga para a resposta, arredondando para múltiplos de 1024 e limitando por um teto
/// (para não rebentar a VRAM). Nunca descemos abaixo do valor configurado pelo utilizador.
///
/// `estimate_tokens` (caracteres÷4) SUBESTIMA ~15% em português (acentos tokenizam mais);
/// se confiarmos nela à risca, a contagem real do prompt come a folga e a resposta corta-se
/// (visto: estimado 15k → num_ctx 17408, mas o prompt real eram 17199 → só 209 p/ resposta).
/// Por isso inflacionamos a estimativa antes de dimensionar a janela.
fn effective_num_ctx(base: u32, messages: &[ChatMessage]) -> u32 {
    const RESERVE: u64 = 4096; // espaço reservado para a resposta (resumos querem espaço)
    const CAP: u64 = 32768; // teto para limitar o uso de VRAM/latência
    const FUDGE: f64 = 1.3; // margem para a subestimação do tokenizer (PT/acentos)
    let prompt: u64 = messages.iter().map(|m| estimate_tokens(&m.content)).sum();
    let needed = (prompt as f64 * FUDGE) as u64 + RESERVE;
    // Arredonda para cima ao próximo múltiplo de 1024.
    let rounded = needed.div_ceil(1024) * 1024;
    let target = rounded.min(CAP).max(base as u64);
    target as u32
}

pub struct AppState {
    pub settings: Mutex<Settings>,
    pub accounting: Mutex<Accounting>,
    pub db: Mutex<Connection>,
    /// Sidecar do browser, criado preguiçosamente na 1.ª utilização de ferramentas.
    pub browser: tokio::sync::Mutex<Option<PlaywrightSidecar>>,
    /// Servidores MCP ativos, lançados preguiçosamente.
    pub mcp: tokio::sync::Mutex<McpManager>,
    /// Aprovações de ações pendentes (id → canal de resposta), para o modo "ask".
    pub pending: tokio::sync::Mutex<HashMap<u64, oneshot::Sender<bool>>>,
    pub approval_seq: AtomicU64,
    /// Planos pendentes de aprovação (id → canal); `None` = rejeitado, `Some((steps, research))` =
    /// aprovado (passos editados + se executa fundamentado na web).
    pub pending_plans: tokio::sync::Mutex<HashMap<u64, oneshot::Sender<Option<(Vec<String>, bool)>>>>,
    /// Esclarecimentos pendentes (id → (canal, modelo)); `None` = saltou, `Some(answers)` = respondeu.
    /// O modelo é guardado para o `respond_clarify` afinar o viés adaptativo desse modelo.
    pub pending_clarify: tokio::sync::Mutex<HashMap<u64, (oneshot::Sender<Option<Vec<String>>>, String)>>,
    /// Confirmações de pesquisa pendentes (Smart Saga: id → canal). `true` = pesquisa este turno.
    pub pending_search: tokio::sync::Mutex<HashMap<u64, oneshot::Sender<bool>>>,
    /// Gerações em curso (conversation_id → canal de cancelamento). O botão "Parar" dispara-o e a
    /// geração termina cooperativamente, preservando o texto já produzido.
    pub cancels: Mutex<HashMap<i64, oneshot::Sender<()>>>,
    /// Watchers de pasta de projeto ativos (topic_id → watcher). Um por diálogo "Ver ficheiros"
    /// aberto; parar/substituir remove a entrada, o que faz o watcher (RAII) parar sozinho.
    pub project_watchers: Mutex<HashMap<i64, notify::RecommendedWatcher>>,
    /// Serializa gerações na rota LOCAL (Ollama/LM Studio): só uma de cada vez, porque competem
    /// pela mesma GPU/VRAM — correr duas em paralelo não dá mais débito, só torna as duas mais
    /// lentas (e pode nem caber em VRAM). O Claude não usa este lock — cada conversa gera livre e
    /// concorrentemente, já que corre na infraestrutura da Anthropic, não no hardware local. Uma
    /// 2.ª conversa a pedir geração local espera aqui (fila), sem bloquear o resto da UI.
    pub local_gen: tokio::sync::Mutex<()>,
}

impl AppState {
    pub fn new() -> Self {
        let db = store::open().expect("falha a abrir a base de dados SQLite");
        Self {
            settings: Mutex::new(Settings::load()),
            accounting: Mutex::new(Accounting::default()),
            db: Mutex::new(db),
            browser: tokio::sync::Mutex::new(None),
            mcp: tokio::sync::Mutex::new(McpManager::default()),
            pending: tokio::sync::Mutex::new(HashMap::new()),
            approval_seq: AtomicU64::new(0),
            pending_plans: tokio::sync::Mutex::new(HashMap::new()),
            pending_clarify: tokio::sync::Mutex::new(HashMap::new()),
            pending_search: tokio::sync::Mutex::new(HashMap::new()),
            cancels: Mutex::new(HashMap::new()),
            project_watchers: Mutex::new(HashMap::new()),
            local_gen: tokio::sync::Mutex::new(()),
        }
    }
}

/// Implementação de `Approver`: envia um pedido de aprovação à UI e espera a resposta.
struct ChannelApprover<'a> {
    channel: Channel<StreamEvent>,
    state: &'a AppState,
}

impl Approver for ChannelApprover<'_> {
    fn request<'a>(&'a self, tool: &'a str, preview: &'a str) -> ApprovalFut<'a> {
        Box::pin(async move {
            let id = self.state.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let (tx, rx) = oneshot::channel();
            self.state.pending.lock().await.insert(id, tx);
            let _ = self.channel.send(StreamEvent::ApprovalRequest {
                id,
                tool: tool.to_string(),
                preview: preview.to_string(),
            });
            rx.await.unwrap_or(false)
        })
    }
}

/// Eventos enviados ao frontend durante o streaming.
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum StreamEvent {
    Start {
        route: String,
        model: String,
        reason: String,
    },
    Delta {
        text: String,
    },
    Thinking {
        text: String,
    },
    ToolStep {
        tool: String,
        detail: String,
    },
    ApprovalRequest {
        id: u64,
        tool: String,
        preview: String,
    },
    /// Perguntas de esclarecimento antes de planear (Plan mode); a UI responde com `respond_clarify`.
    Clarify {
        id: u64,
        questions: Vec<String>,
    },
    /// Smart Saga (chat normal, fora do Plan mode): o pedido parece precisar de dados atuais e o
    /// turno ainda não tem acesso à web — pergunta antes de pesquisar. A UI responde com
    /// `respond_search_confirm`.
    SearchConfirm {
        id: u64,
        hint: String,
    },
    /// Plano rascunhado, à espera de aprovação/edição do utilizador (Plan mode).
    Plan {
        id: u64,
        steps: Vec<String>,
        /// O modelo sinalizou que executar bem o plano precisa de dados atuais/online.
        needs_web: bool,
        /// Estado atual do 🔎 (pesquisa web) no momento do rascunho.
        research: bool,
    },
    /// Estado de execução de um passo do plano: "executing" | "done" | "error".
    PlanStep {
        index: u32,
        status: String,
    },
    Done {
        /// Id da mensagem do assistente gravada (para persistir os breadcrumbs de ferramentas). 0 = falhou.
        message_id: i64,
        /// Grupo de versões desta mensagem (ver StoredMessage) — 0 se a gravação falhou.
        version_group_id: i64,
        /// Quantas versões existem neste grupo (1 = ainda não foi regenerada).
        version_count: i64,
        /// Posição desta versão no grupo (1-based).
        version_index: i64,
        input_tokens: u64,
        output_tokens: u64,
        tokens_saved: u64,
        cost_usd: f64,
        gen_ms: i64,
        /// Intenção classificada do pedido (camada reasoning): "shopping" | "general".
        intent: String,
        /// Nível Think que REALMENTE correu (verify/debate só no chat local simples; senão degrada).
        think_level: String,
        /// Concordância das amostras no modo "verify" (0–1). None fora do verify.
        confidence: Option<f32>,
        accounting: Accounting,
    },
}

#[derive(Serialize)]
pub struct ChatResponse {
    pub text: String,
    pub route: String,
    pub model: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub tokens_saved: u64,
    pub cost_usd: f64,
    pub reason: String,
    pub accounting: Accounting,
}

#[tauri::command]
pub fn get_settings(state: State<AppState>) -> Settings {
    state.settings.lock().unwrap().clone()
}

#[tauri::command]
pub fn save_settings(state: State<AppState>, mut settings: Settings) -> Result<(), String> {
    // Campos geridos pelo backend (não vêm da UI) — preserva-os para um save da UI não os limpar.
    {
        let cur = state.settings.lock().unwrap();
        settings.clarify_bias = cur.clarify_bias.clone();
        settings.embed_model = cur.embed_model.clone();
    }
    settings.save().map_err(|e| e.to_string())?;
    *state.settings.lock().unwrap() = settings;
    Ok(())
}

#[tauri::command]
pub fn get_accounting(state: State<AppState>) -> Accounting {
    state.accounting.lock().unwrap().clone()
}

#[tauri::command]
pub fn reset_accounting(state: State<AppState>) -> Accounting {
    let mut acc = state.accounting.lock().unwrap();
    *acc = Accounting::default();
    acc.clone()
}

#[tauri::command]
pub fn get_memory_preview(state: State<AppState>) -> String {
    let settings = state.settings.lock().unwrap().clone();
    memory::preview(&settings, 2000)
}

#[derive(Serialize)]
pub struct Diagnostics {
    pub ollama_ok: bool,
    pub ollama_models: Vec<String>,
    pub ollama_model_present: bool,
    pub claude_mode: String,
    pub claude_ready: bool,
    pub claude_detail: String,
}

/// Verifica o que está disponível (Ollama, Claude) para o wizard de 1.º arranque.
#[tauri::command]
pub async fn diagnostics(state: State<'_, AppState>) -> Result<Diagnostics, String> {
    let settings = state.settings.lock().unwrap().clone();

    let (ollama_ok, ollama_models) =
        match providers::ollama::list_models(&settings.ollama_endpoint).await {
            Ok(models) => (true, models),
            Err(_) => (false, Vec::new()),
        };
    let cfg = settings.ollama_model.clone();
    let ollama_model_present = ollama_models
        .iter()
        .any(|m| m == &cfg || m.split(':').next() == Some(cfg.as_str()));

    let (claude_ready, claude_detail) = match settings.claude_mode.as_str() {
        "api" => {
            if settings.claude_api_key.trim().is_empty() {
                (false, "API key em falta".into())
            } else {
                (true, "API key configurada".into())
            }
        }
        "cli" => {
            // Resolve o caminho real (apps GUI no macOS têm PATH mínimo) e dá um PATH aumentado.
            let path = crate::which::launch_path(&settings.claude_cli_path);
            let env_path = crate::which::augmented_path();
            let ok = tauri::async_runtime::spawn_blocking(move || {
                #[allow(unused_mut)]
                let mut cmd = std::process::Command::new(&path);
                cmd.arg("--version").env("PATH", &env_path);
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
                }
                cmd.output().map(|o| o.status.success()).unwrap_or(false)
            })
            .await
            .unwrap_or(false);
            if ok {
                (true, "Claude CLI detetada".into())
            } else {
                (
                    false,
                    "Claude CLI não encontrada — instala-a ou define o caminho completo em Modelos".into(),
                )
            }
        }
        _ => (false, "Claude desligado".into()),
    };

    Ok(Diagnostics {
        ollama_ok,
        ollama_models,
        ollama_model_present,
        claude_mode: settings.claude_mode.clone(),
        claude_ready,
        claude_detail,
    })
}

// ---- Histórico de conversas ----

#[tauri::command]
pub fn list_conversations(state: State<AppState>) -> Result<Vec<ConversationMeta>, String> {
    let conn = state.db.lock().unwrap();
    store::list_conversations(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_conversation(state: State<AppState>, id: i64) -> Result<Vec<StoredMessage>, String> {
    let conn = state.db.lock().unwrap();
    store::get_messages(&conn, id).map_err(|e| e.to_string())
}

/// Guarda os breadcrumbs de ferramentas (já formatados pela UI) na mensagem do assistente, para que
/// persistam entre reinícios da app.
#[tauri::command]
pub fn set_message_steps(
    state: State<AppState>,
    message_id: i64,
    steps: Vec<String>,
) -> Result<(), String> {
    if message_id <= 0 {
        return Ok(());
    }
    let json = serde_json::to_string(&steps).unwrap_or_else(|_| "[]".into());
    let conn = state.db.lock().unwrap();
    store::set_message_steps(&conn, message_id, &json).map_err(|e| e.to_string())
}

/// Todas as versões (regenerações) de uma mensagem, para o ciclo ‹anterior/seguinte›.
#[tauri::command]
pub fn list_message_versions(state: State<AppState>, message_id: i64) -> Result<Vec<StoredMessage>, String> {
    let conn = state.db.lock().unwrap();
    let version_group_id: i64 = conn
        .query_row(
            "SELECT version_group_id FROM messages WHERE id = ?1",
            [message_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    store::list_message_versions(&conn, version_group_id).map_err(|e| e.to_string())
}

/// Ativa uma versão específica de uma mensagem regenerada (ciclar ‹/›) — troca só a flag
/// `superseded`, sem gerar nem copiar nada.
#[tauri::command]
pub fn set_active_version(state: State<AppState>, message_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    let version_group_id: i64 = conn
        .query_row(
            "SELECT version_group_id FROM messages WHERE id = ?1",
            [message_id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    store::set_active_version(&conn, version_group_id, message_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn new_conversation(
    state: State<AppState>,
    title: Option<String>,
    topic_id: Option<i64>,
) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    store::create_conversation(&conn, title.as_deref().unwrap_or("Nova conversa"), topic_id)
        .map_err(|e| e.to_string())
}

// ---- Tópicos ----

#[tauri::command]
pub fn list_topics(state: State<AppState>) -> Result<Vec<store::Topic>, String> {
    let conn = state.db.lock().unwrap();
    store::list_topics(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_topic(state: State<AppState>, name: String) -> Result<i64, String> {
    let conn = state.db.lock().unwrap();
    store::create_topic(&conn, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_topic(state: State<AppState>, id: i64, name: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::rename_topic(&conn, id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_topic(
    state: State<AppState>,
    id: i64,
    brief: String,
    notes: String,
    folder_path: String,
    permission_mode: String,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::update_topic(&conn, id, &brief, &notes, &folder_path, &permission_mode)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_topic(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::delete_topic(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn set_conversation_topic(
    state: State<AppState>,
    conversation_id: i64,
    topic_id: Option<i64>,
) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::set_conversation_topic(&conn, conversation_id, topic_id).map_err(|e| e.to_string())
}

// ---- Self-distilling (destilar padrões de um tópico em docs do workspace) ----

/// Proposta de destilação: um padrão replicável detetado nas conversas de um tópico,
/// pronto a rever e guardar como skill | playbook | workflow.
#[derive(Serialize)]
pub struct DistillProposal {
    /// Há algo que valha a pena capturar?
    pub found: bool,
    /// Tipo sugerido: "skill" | "playbook" | "workflow".
    pub doc_type: String,
    pub name: String,
    pub description: String,
    /// Uma frase a explicar o padrão (mostrada na proposta, read-only).
    pub reason: String,
    /// Markdown gerado (com frontmatter quando aplicável) — abre no editor via parseDocFields.
    pub body: String,
}

/// Extrai o primeiro objeto JSON `{...}` balanceado de um texto (o modelo local às vezes
/// embrulha o JSON em texto ou cercas). Devolve `None` se não houver.
fn extract_json_object(s: &str) -> Option<String> {
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in s[start..].char_indices() {
        match c {
            _ if esc => esc = false,
            '\\' if in_str => esc = true,
            '"' => in_str = !in_str,
            '{' if !in_str => depth += 1,
            '}' if !in_str => {
                depth -= 1;
                if depth == 0 {
                    return Some(s[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Lista os nomes dos docs já existentes (e ativos) num tópico, para o modelo não os repetir.
fn existing_doc_names(dir: &str, topic: &str) -> Vec<String> {
    let idx = crate::workspace::index(dir).active(Some(topic));
    idx.skills
        .iter()
        .chain(idx.playbooks.iter())
        .chain(idx.workflows.iter())
        .map(|d| d.name.clone())
        .collect()
}

/// Classificador: lê o transcript do tópico e decide se há UM padrão replicável e de que tipo.
/// Devolve `(type, name, reason)` ou `None`. Tolerante a JSON sujo do modelo local.
async fn classify_pattern(
    settings: &Settings,
    topic: &str,
    transcript: &str,
    existing: &[String],
) -> Option<(String, String, String)> {
    if transcript.trim().is_empty() {
        return None;
    }
    let avoid = if existing.is_empty() {
        "(nenhum)".to_string()
    } else {
        existing.join(", ")
    };
    let sys = "És um destilador de conhecimento da Saga. Lês conversas de um tópico e decides se há UM \
padrão replicável que valha a pena guardar como documento reutilizável do workspace.\n\
Tipos:\n\
- skill: conhecimento durável, técnica ou convenção reutilizável (dispara por palavras-chave numa conversa futura).\n\
- playbook: um how-to/procedimento que o utilizador volta a explicar.\n\
- workflow: uma tarefa multi-passo repetível (sequência fixa de passos/ferramentas).\n\
Responde APENAS com JSON, sem texto à volta:\n\
{\"found\": true|false, \"type\": \"skill\"|\"playbook\"|\"workflow\", \"name\": \"<slug-curto-sem-espacos>\", \"reason\": \"<uma frase>\"}\n\
Se nada for claramente replicável, responde {\"found\": false}. Sê exigente — não inventes padrões.";
    let instruction = format!(
        "Tópico: {topic}\nDocs que JÁ existem (não repitas): {avoid}\n\nConversas:\n{transcript}"
    );
    let raw = run_doc_gen(settings, sys, instruction, false).await.ok()?;
    let json = extract_json_object(&raw)?;
    let v: serde_json::Value = serde_json::from_str(&json).ok()?;
    if !v.get("found").and_then(|f| f.as_bool()).unwrap_or(false) {
        return None;
    }
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("playbook");
    let ty = match ty {
        "skill" | "playbook" | "workflow" => ty,
        _ => "playbook",
    }
    .to_string();
    let name = v
        .get("name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let reason = v
        .get("reason")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some((ty, name, reason))
}

/// Destila um tópico: deteta um padrão replicável e (em modo `draft`) redige o doc para revisão.
/// `type_hint` força o tipo (quando o utilizador o muda na proposta) e salta o classificador.
#[tauri::command]
pub async fn distill_topic(
    state: State<'_, AppState>,
    topic_id: i64,
    draft: bool,
    type_hint: Option<String>,
    use_cloud: bool,
) -> Result<DistillProposal, String> {
    let settings = state.settings.lock().unwrap().clone();
    let (topic_name, transcript) = {
        let conn = state.db.lock().unwrap();
        let name = store::list_topics(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|t| t.id == topic_id)
            .map(|t| t.name)
            .ok_or_else(|| "Tópico não encontrado.".to_string())?;
        let tr = store::topic_transcript(&conn, topic_id, 8000).map_err(|e| e.to_string())?;
        (name, tr)
    };
    if transcript.trim().is_empty() {
        return Ok(DistillProposal {
            found: false,
            doc_type: String::new(),
            name: String::new(),
            description: String::new(),
            reason: String::new(),
            body: String::new(),
        });
    }
    let existing = existing_doc_names(&settings.workspace_dir, &topic_name);

    // Tipo + nome + razão. Com `type_hint` saltamos o classificador (já sabemos o tipo).
    let (kind, suggested_name, reason) = match type_hint.as_deref() {
        Some(t) if !t.trim().is_empty() => (t.trim().to_string(), String::new(), String::new()),
        _ => match classify_pattern(&settings, &topic_name, &transcript, &existing).await {
            Some(x) => x,
            None => {
                return Ok(DistillProposal {
                    found: false,
                    doc_type: String::new(),
                    name: String::new(),
                    description: String::new(),
                    reason: String::new(),
                    body: String::new(),
                })
            }
        },
    };

    // Só classificar (pílula passiva): devolve sem redigir o corpo.
    if !draft {
        return Ok(DistillProposal {
            found: true,
            doc_type: kind,
            name: suggested_name,
            description: String::new(),
            reason,
            body: String::new(),
        });
    }

    // Redigir o doc a partir das conversas, com âmbito do tópico.
    let avoid = if existing.is_empty() {
        "(nenhum)".to_string()
    } else {
        existing.join(", ")
    };
    let name_hint = if suggested_name.is_empty() {
        String::new()
    } else {
        format!("Nome sugerido: {suggested_name}.\n")
    };
    let topic_line = if kind == "playbook" {
        String::new()
    } else {
        format!("Inclui no frontmatter a linha `topic: {topic_name}`.\n")
    };
    let instruction = format!(
        "Com base nestas conversas do tópico '{topic_name}', escreve o {kind} reutilizável que \
captura o padrão. {name_hint}{topic_line}Não repitas estes docs já existentes: {avoid}.\n\nConversas:\n{transcript}"
    );
    let body = run_doc_gen(&settings, doc_gen_sys(&kind), instruction, use_cloud).await?;
    let (fm_name, fm_desc) = crate::workspace::parse_frontmatter(&body);
    let name = fm_name
        .filter(|n| !n.trim().is_empty())
        .unwrap_or(suggested_name);
    Ok(DistillProposal {
        found: true,
        doc_type: kind,
        name,
        description: fm_desc.unwrap_or_default(),
        reason,
        body,
    })
}

/// Dispensa a dica de destilação pendente de um tópico (clica no "✕" da pílula).
#[tauri::command]
pub fn dismiss_distill_hint(state: State<AppState>, topic_id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::clear_distill_hint(&conn, topic_id).map_err(|e| e.to_string())
}

/// Grava conteúdo (ex.: um artefacto gerado) na pasta do projeto da conversa — caminho relativo,
/// sandboxed à pasta. Ação iniciada pelo utilizador (o clique é a confirmação); fica no action log.
#[tauri::command]
pub fn project_save_file(
    state: State<AppState>,
    conversation_id: i64,
    path: String,
    content: String,
) -> Result<String, String> {
    let conn = state.db.lock().unwrap();
    let topic = store::get_topic_for_conversation(&conn, conversation_id)
        .ok_or_else(|| "Esta conversa não pertence a um projeto.".to_string())?;
    let root = topic.folder_path.trim();
    if root.is_empty() {
        return Err("O tópico não tem pasta de projeto.".into());
    }
    // Independente do permission_mode: o próprio clique + diálogo nativo de gravação já é a
    // confirmação do utilizador, não uma escrita autónoma do agente.
    crate::tools::project::write_file(root, &path, &content)?;
    let _ = store::insert_action(
        &conn,
        conversation_id,
        "project_save_file",
        &serde_json::json!({ "path": path }).to_string(),
        "OK",
        &path,
        "",
    );
    Ok(path)
}

/// Pasta de projeto de um tópico (por id, não por conversa) — usado pelas ações "Abrir pasta" e
/// "Ficheiros do projeto" na sidebar, que não têm uma conversa aberta associada.
fn topic_folder(conn: &Connection, topic_id: i64) -> Result<String, String> {
    let topics = store::list_topics(conn).map_err(|e| e.to_string())?;
    let folder = topics
        .into_iter()
        .find(|t| t.id == topic_id)
        .map(|t| t.folder_path.trim().to_string())
        .ok_or_else(|| "Tópico não encontrado.".to_string())?;
    if folder.is_empty() {
        return Err("Este tópico não tem pasta de projeto.".into());
    }
    Ok(folder)
}

/// Abre a pasta do projeto no explorador de ficheiros do SO ("ir à pasta rapidamente").
#[tauri::command]
pub fn open_project_folder(app: tauri::AppHandle, state: State<AppState>, topic_id: i64) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let folder = {
        let conn = state.db.lock().unwrap();
        topic_folder(&conn, topic_id)?
    };
    app.opener()
        .open_path(folder, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Lista os ficheiros da pasta do projeto (caminhos relativos) — para o diálogo de pré-visualização.
#[tauri::command]
pub fn list_project_files(state: State<AppState>, topic_id: i64) -> Result<Vec<String>, String> {
    let folder = {
        let conn = state.db.lock().unwrap();
        topic_folder(&conn, topic_id)?
    };
    Ok(crate::tools::project::list_files(&folder, 500))
}

/// Lê o conteúdo bruto de um ficheiro do projeto — para abrir no painel de artefactos (preview).
#[tauri::command]
pub fn read_project_file_raw(state: State<AppState>, topic_id: i64, path: String) -> Result<String, String> {
    let folder = {
        let conn = state.db.lock().unwrap();
        topic_folder(&conn, topic_id)?
    };
    crate::tools::project::read_file_raw(&folder, &path)
}

/// Eventos do watcher de pasta de projeto — o payload é só "algo mudou"; o frontend volta a
/// chamar `list_project_files` para saber o quê (mais simples e robusto do que tentar traduzir
/// eventos brutos do SO em criações/edições/remoções exatas).
#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum ProjectWatchEvent {
    Changed,
}

/// Começa a vigiar a pasta do projeto (recursivo) e empurra um evento para `channel` de cada vez
/// que algo muda — para o diálogo "Ver ficheiros" se atualizar sozinho. Substitui um watcher já
/// ativo para o mesmo tópico (ex.: reabrir o diálogo).
#[tauri::command]
pub fn start_project_watch(
    state: State<AppState>,
    topic_id: i64,
    channel: Channel<ProjectWatchEvent>,
) -> Result<(), String> {
    let folder = {
        let conn = state.db.lock().unwrap();
        topic_folder(&conn, topic_id)?
    };
    use notify::Watcher;
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if res.is_ok() {
            let _ = channel.send(ProjectWatchEvent::Changed);
        }
    })
    .map_err(|e| e.to_string())?;
    watcher
        .watch(std::path::Path::new(&folder), notify::RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    state.project_watchers.lock().unwrap().insert(topic_id, watcher);
    Ok(())
}

/// Para de vigiar (dropar o watcher já para o SO de o notificar) — chamado quando o diálogo fecha.
#[tauri::command]
pub fn stop_project_watch(state: State<AppState>, topic_id: i64) -> Result<(), String> {
    state.project_watchers.lock().unwrap().remove(&topic_id);
    Ok(())
}

#[tauri::command]
pub fn rename_conversation(state: State<AppState>, id: i64, title: String) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::rename_conversation(&conn, id, &title).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_conversation(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::delete_conversation(&conn, id).map_err(|e| e.to_string())
}

/// Destila uma Saga para uma nota em `memory_dir`, antes de a apagar (oferta do frontend no
/// diálogo de apagar). `scope_hint` nomeia a nota — nome do tópico da conversa, ou um assunto
/// livre escolhido pelo utilizador. Não apaga a conversa: isso é um passo separado do frontend,
/// só chamado depois de esta chamada ter sucesso (para não perder a conversa se o resumo falhar).
#[tauri::command]
pub async fn distill_conversation_to_memory(
    state: State<'_, AppState>,
    conversation_id: i64,
    scope_hint: String,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    let transcript = {
        let conn = state.db.lock().unwrap();
        store::conversation_transcript(&conn, conversation_id).map_err(|e| e.to_string())?
    };
    let summary = router::summarize_conversation(&transcript, &settings)
        .await
        .ok_or_else(|| "Não foi possível resumir — verifica o modelo local.".to_string())?;
    let hint = {
        let h = scope_hint.trim();
        if h.is_empty() { "conversa".to_string() } else { h.to_string() }
    };
    let note = format!("# {hint}\n\n{summary}\n");
    memory::write_memory_note(&settings.memory_dir, &hint, &note).map_err(|e| e.to_string())?;
    Ok(summary)
}

#[tauri::command]
pub fn search_chats(state: State<AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    let conn = state.db.lock().unwrap();
    store::search_messages(&conn, &query).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_conversation_accounting(state: State<AppState>, id: i64) -> Result<Accounting, String> {
    let conn = state.db.lock().unwrap();
    store::conversation_accounting(&conn, id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn truncate_conversation(state: State<AppState>, id: i64, keep: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::truncate_conversation(&conn, id, keep).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct Compaction {
    pub summary: String,
    pub upto: i64,
}

#[derive(Serialize)]
pub struct CompactResult {
    pub summary: String,
    pub upto: i64,
    pub messages_compacted: usize,
}

/// Lê o resumo/fronteira de compactação de uma Saga (para o frontend repor ao abrir).
#[tauri::command]
pub fn get_compaction(state: State<AppState>, id: i64) -> Result<Compaction, String> {
    let conn = state.db.lock().unwrap();
    let (summary, upto) = store::get_compaction(&conn, id).map_err(|e| e.to_string())?;
    Ok(Compaction { summary, upto })
}

/// Esvazia uma Saga (apaga mensagens + limpa compactação), mantendo-a na lista.
#[tauri::command]
pub fn clear_conversation(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::clear_conversation(&conn, id).map_err(|e| e.to_string())
}

/// Compacta uma Saga: resume os turnos antigos com o modelo local (não-destrutivo) e
/// marca a fronteira; mantém os últimos `keep_last` turnos verbatim.
#[tauri::command]
pub async fn compact_conversation(
    state: State<'_, AppState>,
    id: i64,
    keep_last: i64,
) -> Result<CompactResult, String> {
    let settings = state.settings.lock().unwrap().clone();
    let (msgs, prev_summary) = {
        let conn = state.db.lock().unwrap();
        let msgs = store::get_messages(&conn, id).map_err(|e| e.to_string())?;
        let prev = store::get_compaction(&conn, id)
            .map(|(s, _)| s)
            .unwrap_or_default();
        (msgs, prev)
    };
    let total = msgs.len() as i64;
    let keep = keep_last.max(0);
    let cut = (total - keep).max(0) as usize;
    if cut < 2 {
        return Err("Conversa demasiado curta para compactar.".to_string());
    }
    let to_summarize = &msgs[..cut];
    let upto = to_summarize.last().map(|m| m.id).unwrap_or(0);
    let transcript = to_summarize
        .iter()
        .map(|m| {
            let who = if m.role == "user" { "Utilizador" } else { "Assistente" };
            format!("{who}: {}", m.content)
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    let full = if prev_summary.trim().is_empty() {
        transcript
    } else {
        format!("Resumo anterior:\n{prev_summary}\n\n{transcript}")
    };
    let summary = router::summarize_conversation(&full, &settings)
        .await
        .ok_or_else(|| "Não foi possível resumir — verifica o modelo local.".to_string())?;
    {
        let conn = state.db.lock().unwrap();
        store::set_compaction(&conn, id, &summary, upto).map_err(|e| e.to_string())?;
    }
    // Gancho passivo de destilação: a compactação já correu o modelo sobre o transcript, por isso
    // aproveitamos para detetar (barato) um padrão replicável no tópico e pousar uma dica discreta.
    // Falhas são silenciosas — nunca partem a compactação.
    distill_hint_pass(&state, id).await;
    Ok(CompactResult {
        summary,
        upto,
        messages_compacted: cut,
    })
}

/// Corre o classificador de destilação sobre o tópico da conversa `conv_id` e, se encontrar um
/// padrão novo (nome ainda não existe no tópico), grava a dica no tópico (para a pílula passiva).
/// Best-effort: qualquer falha é ignorada.
async fn distill_hint_pass(state: &State<'_, AppState>, conv_id: i64) {
    let settings = state.settings.lock().unwrap().clone();
    let (topic_id, topic_name, transcript) = {
        let conn = state.db.lock().unwrap();
        let Some(topic) = store::get_topic_for_conversation(&conn, conv_id) else {
            return;
        };
        let tr = store::topic_transcript(&conn, topic.id, 8000).unwrap_or_default();
        (topic.id, topic.name, tr)
    };
    let existing = existing_doc_names(&settings.workspace_dir, &topic_name);
    if let Some((ty, name, reason)) =
        classify_pattern(&settings, &topic_name, &transcript, &existing).await
    {
        // Nome já coberto neste tópico → não vale a pena incomodar.
        if !name.is_empty() && existing.iter().any(|e| e.eq_ignore_ascii_case(&name)) {
            return;
        }
        let hint = serde_json::json!({ "type": ty, "name": name, "reason": reason }).to_string();
        let conn = state.db.lock().unwrap();
        let _ = store::set_distill_hint(&conn, topic_id, &hint);
    }
}

/// Para a geração em curso de uma Saga (botão "Parar"). A geração termina cooperativamente
/// e o texto já produzido é preservado.
#[tauri::command]
pub fn cancel_generation(state: State<AppState>, conversation_id: i64) {
    if let Some(tx) = state.cancels.lock().unwrap().remove(&conversation_id) {
        let _ = tx.send(());
    }
}

/// Escreve `content` no caminho dado (usado para exportar artefactos/Sagas; o caminho
/// vem do save-dialog no frontend).
#[tauri::command]
pub fn export_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

/// Remove cercas de código ```…``` se o modelo as colocar à volta da resposta.
fn strip_fences(s: &str) -> String {
    let t = s.trim();
    if let Some(rest) = t.strip_prefix("```") {
        let after_lang = rest.splitn(2, '\n').nth(1).unwrap_or("");
        return after_lang.trim_end().trim_end_matches("```").trim().to_string();
    }
    t.to_string()
}

/// System prompt para gerar um documento do workspace de um dado tipo. Partilhado por
/// `generate_doc` e pela destilação (`distill_topic`).
fn doc_gen_sys(kind: &str) -> &'static str {
    match kind {
        "skill" => "Escreve uma SKILL.md para a Saga. Formato EXATO:\n---\nname: <slug-sem-espacos>\ndescription: \"<uma frase sobre quando usar>. Triggers: <palavras/expressões que ativam>\"\n---\n\n# <título>\n<instruções claras, passo a passo, em markdown>\n\nResponde APENAS com o markdown final — sem cercas de código nem comentários.",
        "workflow" => "Escreve um workflow em markdown para a Saga. Formato EXATO:\n---\nname: <slug-sem-espacos>\ndescription: \"<o que faz>\"\nargument-hint: <que argumentos espera>\nroute: <local|claude — usa 'claude' SÓ se precisar de browser/MCP; senão 'local'>\n---\n\n<procedimento passo-a-passo; usa $ARGUMENTS onde os argumentos do utilizador entram>\n\nResponde APENAS com o markdown final — sem cercas nem comentários.",
        "agent" => "Escreve um agente (persona) em markdown para a Saga. Formato EXATO:\n---\nname: <Nome legível>\ndescription: \"<uma frase sobre o que faz>\"\ntools: <true|false>\nresearch: <true|false>\nsubagents: <true|false>\nroute: <local|claude>\n---\n\n<system prompt na 2.ª pessoa (\"És um…\"): define o papel, o estilo e as regras de comportamento do agente>\n\nResponde APENAS com o markdown final — sem cercas de código nem comentários.",
        _ => "Escreve um playbook em markdown simples (sem frontmatter): um título e um procedimento reutilizável e claro. Responde APENAS com o markdown — sem cercas nem comentários.",
    }
}

/// Corre uma geração de uma só passagem (system + user) no provider configurado.
/// Local-first: só tenta o cloud se `use_cloud` e mesmo aí cai para o local se o cloud falhar.
/// Devolve o texto já sem cercas de código.
async fn run_doc_gen(
    settings: &Settings,
    sys: &str,
    instruction: String,
    use_cloud: bool,
) -> Result<String, String> {
    let messages = vec![
        ChatMessage { role: "system".into(), content: sys.into(), attachments: Vec::new() },
        ChatMessage { role: "user".into(), content: instruction, attachments: Vec::new() },
    ];
    let max = settings.claude_max_tokens.max(2048);
    let cloud = if !use_cloud {
        None
    } else if settings.cloud_provider == "openai" && !settings.openai_cloud_key.trim().is_empty() {
        Some(providers::openai_compat::chat(&settings.openai_cloud_endpoint, &settings.openai_cloud_key, &settings.openai_cloud_model, &messages, max).await)
    } else if settings.cloud_provider == "claude" && settings.claude_mode == "api" && !settings.claude_api_key.trim().is_empty() {
        Some(providers::claude_api::messages(&settings.claude_api_key, &settings.claude_model, max, &messages, false).await)
    } else if settings.cloud_provider == "claude" && settings.claude_mode == "cli" {
        Some(providers::claude_cli::run(&settings.claude_cli_path, &settings.claude_model, &messages, &[], None).await)
    } else {
        None
    };
    let resp = match cloud {
        Some(Ok(r)) => Ok(r),
        _ if settings.local_provider == "openai" => {
            providers::openai_compat::chat(&settings.openai_local_endpoint, &settings.openai_local_key, &settings.openai_local_model, &messages, max).await
        }
        _ => {
            let g = providers::ollama::GenOpts {
                num_ctx: effective_num_ctx(settings.ollama_num_ctx, &messages),
                temperature: settings.ollama_temp_opt(),
                num_predict: None,
            };
            providers::ollama::chat(&settings.ollama_endpoint, &settings.ollama_model, &messages, g).await
        }
    };
    let text = resp.map_err(|e| e.to_string())?.text;
    Ok(strip_fences(&text))
}

/// Gera um documento de workspace (skill | playbook | workflow) a partir de uma descrição,
/// usando o provider configurado (preferindo o cloud). Devolve o markdown.
#[tauri::command]
pub async fn generate_doc(
    state: State<'_, AppState>,
    kind: String,
    instruction: String,
    use_cloud: bool,
) -> Result<String, String> {
    let settings = state.settings.lock().unwrap().clone();
    run_doc_gen(&settings, doc_gen_sys(&kind), instruction, use_cloud).await
}

/// Semeia os defaults do workspace (skill pdf + agentes) no idioma da UI. Idempotente:
/// não sobrescreve docs editados. Chamado pelo frontend no arranque.
#[tauri::command]
pub fn ensure_workspace_defaults(state: State<AppState>, lang: String) {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::seed_defaults(&dir, &lang);
}

/// Índice do workspace (skills, playbooks, workflows) para a UI e o disparo de workflows.
#[tauri::command]
pub fn get_workspace_index(state: State<AppState>) -> crate::workspace::WorkspaceIndex {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::index(&dir)
}

/// Conteúdo cru (com frontmatter) de um documento do workspace, para edição.
#[tauri::command]
pub fn read_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
) -> Result<String, String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::read_doc(&dir, &kind, &name)
        .ok_or_else(|| "documento não encontrado".to_string())
}

/// Cria/atualiza um documento do workspace (skill | playbook | workflow).
#[tauri::command]
pub fn save_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
    content: String,
) -> Result<(), String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::write_doc(&dir, &kind, &name, &content).map_err(|e| e.to_string())
}

/// Apaga um documento do workspace.
#[tauri::command]
pub fn delete_workspace_doc(
    state: State<AppState>,
    kind: String,
    name: String,
) -> Result<(), String> {
    let dir = state.settings.lock().unwrap().workspace_dir.clone();
    crate::workspace::delete_doc(&dir, &kind, &name).map_err(|e| e.to_string())
}

/// Log de ações (tool-calling) de uma conversa, para a vista "Atividade".
#[tauri::command]
pub fn get_action_log(
    state: State<AppState>,
    conversation_id: i64,
) -> Result<Vec<store::ActionLogEntry>, String> {
    let conn = state.db.lock().unwrap();
    store::get_action_log(&conn, conversation_id).map_err(|e| e.to_string())
}

// ---- Agendamentos (automações) ----

#[tauri::command]
pub fn list_schedules(state: State<AppState>) -> Result<Vec<store::Schedule>, String> {
    let conn = state.db.lock().unwrap();
    store::list_schedules(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_schedule(
    state: State<AppState>,
    name: String,
    workflow_name: String,
    arguments: String,
    cron: String,
    enabled: bool,
    model: String,
) -> Result<i64, String> {
    let next = if enabled {
        crate::scheduler::next_epoch(&cron).ok_or("expressão cron inválida")?
    } else {
        0
    };
    let conn = state.db.lock().unwrap();
    store::create_schedule(&conn, &name, &workflow_name, &arguments, &cron, enabled, next, &model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn update_schedule(
    state: State<AppState>,
    id: i64,
    name: String,
    workflow_name: String,
    arguments: String,
    cron: String,
    enabled: bool,
    model: String,
) -> Result<(), String> {
    let next = if enabled {
        crate::scheduler::next_epoch(&cron).ok_or("expressão cron inválida")?
    } else {
        0
    };
    let conn = state.db.lock().unwrap();
    store::update_schedule(&conn, id, &name, &workflow_name, &arguments, &cron, enabled, next, &model)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_schedule(state: State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().unwrap();
    store::delete_schedule(&conn, id).map_err(|e| e.to_string())
}

/// Corre um agendamento imediatamente ("Correr agora").
#[tauri::command]
pub async fn run_schedule_now(app: tauri::AppHandle, id: i64) -> Result<String, String> {
    let sched = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().unwrap();
        store::get_schedule(&conn, id).map_err(|e| e.to_string())?
    };
    let sched = sched.ok_or_else(|| "agendamento não encontrado".to_string())?;
    let (status, summary) = crate::scheduler::run_schedule(&app, &sched).await;
    Ok(format!("{status}: {summary}"))
}

/// Resposta a um pedido de aprovação de ação (modo "ask").
#[tauri::command]
pub async fn approve_action(
    state: State<'_, AppState>,
    id: u64,
    approved: bool,
) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().await.remove(&id) {
        let _ = tx.send(approved);
    }
    Ok(())
}

/// Resposta à aprovação de um plano (Plan mode): `approved=false` → rejeitado;
/// caso contrário entrega os passos (possivelmente editados pelo utilizador).
#[tauri::command]
pub async fn respond_plan(
    state: State<'_, AppState>,
    id: u64,
    approved: bool,
    steps: Vec<String>,
    research: bool,
) -> Result<(), String> {
    if let Some(tx) = state.pending_plans.lock().await.remove(&id) {
        let _ = tx.send(if approved { Some((steps, research)) } else { None });
    }
    Ok(())
}

/// Modelo de embeddings que a clarificação L2 vai usar (override `embed_model` se instalado, senão
/// auto-deteção entre os instalados). `None` = nenhum → a L2 fica dormente (só heurística L1). Para a UI
/// mostrar o estado em vez de ser uma feature escondida.
#[tauri::command]
pub async fn detect_embed_model(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let (endpoint, configured) = {
        let s = state.settings.lock().unwrap();
        (s.ollama_endpoint.clone(), s.embed_model.trim().to_string())
    };
    let models = crate::providers::ollama::list_models(&endpoint).await.unwrap_or_default();
    if !configured.is_empty() {
        if let Some(m) = models
            .iter()
            .find(|m| **m == configured || m.starts_with(&format!("{configured}:")))
        {
            return Ok(Some(m.clone()));
        }
    }
    Ok(models.into_iter().find(|m| crate::clarify::is_embed_model_name(m)))
}

/// Resposta às perguntas de esclarecimento (Plan mode): `answered=false` → saltou; caso contrário
/// entrega as respostas (uma por pergunta, alinhadas por índice; podem vir vazias).
#[tauri::command]
pub async fn respond_clarify(
    state: State<'_, AppState>,
    id: u64,
    answered: bool,
    answers: Vec<String>,
) -> Result<(), String> {
    let Some((tx, model)) = state.pending_clarify.lock().await.remove(&id) else {
        return Ok(());
    };
    let _ = tx.send(if answered { Some(answers) } else { None });
    // Viés adaptativo por modelo: saltar → +1 (pergunto demais); responder → −1 (foi útil). Clamp + persiste.
    let delta = if answered { -1 } else { 1 };
    let mut s = state.settings.lock().unwrap();
    let b = s.clarify_bias.entry(model).or_insert(0);
    *b = (*b + delta).clamp(-3, 3);
    let _ = s.save();
    Ok(())
}

/// Resposta ao cartão do Smart Saga (chat normal): `search=true` → pesquisa este turno.
#[tauri::command]
pub async fn respond_search_confirm(
    state: State<'_, AppState>,
    id: u64,
    search: bool,
) -> Result<(), String> {
    if let Some(tx) = state.pending_search.lock().await.remove(&id) {
        let _ = tx.send(search);
    }
    Ok(())
}

// ---- Arranque com o sistema (autostart) ----

/// Está a app configurada para arrancar com o sistema?
#[tauri::command]
pub fn get_autostart(app: tauri::AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Liga/desliga o arranque com o sistema.
#[tauri::command]
pub fn set_autostart(app: tauri::AppHandle, enable: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enable {
        m.enable().map_err(|e| e.to_string())
    } else {
        m.disable().map_err(|e| e.to_string())
    }
}

// ---- Diagnóstico / logs ----

/// Regista no log um evento vindo do frontend (erros de JS, rejeições não tratadas).
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    match level.as_str() {
        "error" => log::error!("[ui] {message}"),
        "warn" => log::warn!("[ui] {message}"),
        _ => log::info!("[ui] {message}"),
    }
}

/// Caminho da pasta de logs (para mostrar/partilhar nas Definições).
#[tauri::command]
pub fn log_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path()
        .app_log_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Abre a pasta de logs no explorador de ficheiros (via opener, do lado Rust).
#[tauri::command]
pub fn open_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct ClaudeCliModelsResult {
    models: Vec<String>,
    raw: String,
    scratch_dir: String,
}

/// A pasta "scratch" onde o refresh de modelos corre a CLI — mostrada nas Definições para o
/// utilizador a confiar manualmente uma vez (correr `claude` aí num terminal e aceitar o
/// diálogo de confiança). Nunca automatizamos essa aceitação.
#[tauri::command]
pub fn claude_cli_models_scratch_dir(app: tauri::AppHandle) -> Result<String, String> {
    crate::claude_cli_models::scratch_dir(&app)
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

/// Descobre os modelos disponíveis correndo a Claude CLI interativa num PTY, navegando até
/// `/model` e fazendo parsing best-effort do menu — só faz sentido na rota CLI/subscrição, onde
/// não existe um endpoint de listagem (ver claude_cli_models.rs). Sempre devolve o texto bruto
/// capturado, mesmo quando o parsing não encontra nada, para se poder depurar sem adivinhar.
#[tauri::command]
pub async fn refresh_claude_cli_models(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<ClaudeCliModelsResult, String> {
    let cli_path = state.settings.lock().unwrap().claude_cli_path.clone();
    let scratch = crate::claude_cli_models::scratch_dir(&app).map_err(|e| e.to_string())?;
    let scratch_str = scratch.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || crate::claude_cli_models::discover(&cli_path, &scratch))
        .await
        .map_err(|e| format!("falha a correr a descoberta: {e}"))?
        .map(|d| ClaudeCliModelsResult {
            models: d.models,
            raw: d.raw,
            scratch_dir: scratch_str,
        })
        .map_err(|e| e.to_string())
}

/// Extrai texto de um documento anexado (PDF/Word/Excel/texto) a partir dos bytes
/// em base64. Corre em blocking pois a extração (PDF/zip) é CPU-bound e síncrona.
#[tauri::command]
pub async fn extract_file_text(name: String, data_base64: String) -> Result<String, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.trim())
        .map_err(|e| format!("base64 inválido: {e}"))?;
    tokio::task::spawn_blocking(move || crate::extract::extract(&name, &bytes))
        .await
        .map_err(|e| e.to_string())
}

/// Pré-carrega o modelo local em memória para a 1.ª resposta ser imediata (sem cold-start).
/// Fire-and-forget: só aplica ao Ollama e ignora erros (Ollama pode estar desligado).
#[tauri::command]
pub async fn warm_model(state: State<'_, AppState>, model: Option<String>) -> Result<(), String> {
    let (endpoint, default_model, num_ctx, is_ollama) = {
        let s = state.settings.lock().unwrap();
        (
            s.ollama_endpoint.clone(),
            s.ollama_model.clone(),
            s.ollama_num_ctx,
            s.local_provider == "ollama",
        )
    };
    if !is_ollama {
        return Ok(());
    }
    let model = model.unwrap_or(default_model);
    if model.trim().is_empty() {
        return Ok(());
    }
    let _ = providers::ollama::warm(&endpoint, &model, num_ctx).await;
    Ok(())
}

/// Aplica as otimizações do servidor Ollama (flash attention + KV cache q8_0 + keep-alive)
/// definindo variáveis de ambiente do utilizador (setx — sem admin). NÃO mexe nos processos
/// do Ollama: o utilizador reinicia-o (matar/relançar o Ollama provou-se frágil — deixava-o
/// em baixo ou com servidores a competir pela porta → 100% CPU).
#[tauri::command]
pub async fn optimize_ollama() -> Result<(), String> {
    tokio::task::spawn_blocking(|| set_ollama_opt_blocking(true))
        .await
        .map_err(|e| e.to_string())?
}

/// Reverte as otimizações (remove as variáveis). O utilizador reinicia o Ollama.
#[tauri::command]
pub async fn revert_ollama_opt() -> Result<(), String> {
    tokio::task::spawn_blocking(|| set_ollama_opt_blocking(false))
        .await
        .map_err(|e| e.to_string())?
}

fn set_ollama_opt_blocking(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const VARS: [&str; 3] = ["OLLAMA_FLASH_ATTENTION", "OLLAMA_KV_CACHE_TYPE", "OLLAMA_KEEP_ALIVE"];
        if enable {
            for (k, v) in [
                ("OLLAMA_FLASH_ATTENTION", "1"),
                ("OLLAMA_KV_CACHE_TYPE", "q8_0"),
                ("OLLAMA_KEEP_ALIVE", "30m"),
            ] {
                Command::new("setx")
                    .args([k, v])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map_err(|e| format!("setx {k} falhou: {e}"))?;
            }
        } else {
            // Remove as variáveis do ambiente do utilizador (reg delete; ignora se não existirem).
            for k in VARS {
                let _ = Command::new("reg")
                    .args(["delete", "HKCU\\Environment", "/v", k, "/f"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("Só disponível no Windows. Usa os comandos copiados.".into())
    }
}

/// Constrói um anexo a partir de um caminho do sistema (drag & drop entrega caminhos,
/// não objetos File). Imagens → base64 para a visão; documentos → texto extraído.
#[tauri::command]
pub async fn attachment_from_path(path: String) -> Result<crate::providers::Attachment, String> {
    use base64::Engine;
    let p = std::path::PathBuf::from(&path);
    let name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "ficheiro".into());
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("não foi possível ler {name}: {e}"))?;

    let image_media = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        _ => None,
    };
    if let Some(media) = image_media {
        let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        return Ok(crate::providers::Attachment {
            kind: "image".into(),
            media_type: media.into(),
            data_base64,
            name: name.clone(),
            text: String::new(),
        });
    }
    // Media type para o visor (PDF abre na vista nativa do webview).
    let media_type = match ext.as_str() {
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
    .to_string();
    // Guardamos os bytes crus (base64) para o visor; o texto extraído vai para o modelo.
    let data_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let name2 = name.clone();
    let text = tokio::task::spawn_blocking(move || crate::extract::extract(&name2, &bytes))
        .await
        .map_err(|e| e.to_string())?;
    Ok(crate::providers::Attachment {
        kind: "document".into(),
        media_type,
        data_base64,
        name,
        text,
    })
}

#[tauri::command]
pub async fn list_ollama_models(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

/// Info da máquina + modelo local recomendado (por VRAM se houver GPU, senão por RAM).
#[derive(Serialize)]
pub struct SystemInfo {
    pub total_ram_gb: u64,
    /// VRAM da GPU (NVIDIA) em GB; 0 se não detetada.
    pub total_vram_gb: u64,
    pub cpu_cores: u32,
    pub recommended: String,
    pub note: String,
}

/// VRAM total da GPU NVIDIA via `nvidia-smi` (0 se ausente/erro). Cobre o caso comum (NVIDIA).
/// Resultado em cache (a VRAM não muda) — senão o `nvidia-smi` corria a cada abertura dos Models
/// (lento + janela de consola no Windows). No Windows usa CREATE_NO_WINDOW para não abrir consola.
fn detect_vram_gb() -> u64 {
    static CACHE: std::sync::OnceLock<u64> = std::sync::OnceLock::new();
    *CACHE.get_or_init(|| {
        #[allow(unused_mut)]
        let mut cmd = std::process::Command::new("nvidia-smi");
        cmd.args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let Ok(out) = cmd.output() else { return 0 };
        if !out.status.success() {
            return 0;
        }
        // Uma linha por GPU (MiB); usa a maior.
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| l.trim().parse::<f64>().ok())
            .map(|mib| (mib / 1024.0).round() as u64)
            .max()
            .unwrap_or(0)
    })
}

#[tauri::command]
pub fn system_info() -> SystemInfo {
    let mut sys = sysinfo::System::new();
    sys.refresh_memory();
    let total_ram_gb =
        (sys.total_memory() as f64 / 1024.0 / 1024.0 / 1024.0).round().max(0.0) as u64;
    let cpu_cores = std::thread::available_parallelism()
        .map(|n| n.get() as u32)
        .unwrap_or(0);
    let total_vram_gb = detect_vram_gb();

    // Com GPU, o gargalo é a VRAM: escolhe um modelo que CAIBA na VRAM (corre 100% na GPU =
    // rápido), deixando ~2 GB de folga para o cache KV. Sem GPU, decide pela RAM.
    let (recommended, why) = if total_vram_gb >= 22 {
        ("gemma4:26b-a4b-it-qat", "VRAM grande — Gemma 4 MoE (4B ativos): rápido, multimodal e capaz")
    } else if total_vram_gb >= 11 {
        ("gemma4:12b", "cabe na VRAM — Gemma 4 12B multimodal (imagens/ferramentas/raciocínio)")
    } else if total_vram_gb >= 8 {
        ("gemma4:e4b", "VRAM média — Gemma 4 e4b multimodal e leve")
    } else if total_vram_gb >= 5 {
        ("qwen3:8b", "VRAM pequena — 8B com ferramentas/raciocínio (texto)")
    } else if total_vram_gb > 0 {
        ("llama3.2:3b", "VRAM muito pequena — modelo leve para caber na GPU")
    } else if total_ram_gb == 0 {
        ("gemma4:12b", "multimodal equilibrado — imagens, ferramentas e raciocínio")
    } else if total_ram_gb < 10 {
        ("llama3.2:3b", "sem GPU, RAM limitada — modelo pequeno e rápido (CPU)")
    } else if total_ram_gb < 24 {
        ("qwen3:8b", "sem GPU — 8B em CPU é confortável (ferramentas/raciocínio)")
    } else {
        ("gemma4:12b", "sem GPU, muita RAM — Gemma 4 12B em CPU (mais lento, mas capaz)")
    };
    SystemInfo {
        total_ram_gb,
        total_vram_gb,
        cpu_cores,
        recommended: recommended.into(),
        note: why.into(),
    }
}

/// Uso de pesquisa web do mês corrente, por motor (contador local — o que a Saga gastou).
#[tauri::command]
pub fn get_search_usage(state: State<AppState>) -> Result<Vec<crate::store::SearchUsage>, String> {
    let ym = chrono::Local::now().format("%Y-%m").to_string();
    let conn = state.db.lock().unwrap();
    store::search_usage(&conn, &ym).map_err(|e| e.to_string())
}

/// Pesquisa o registo público do Ollama (ollama.com) — navegador de modelos ao vivo.
#[tauri::command]
pub async fn search_ollama_registry(
    query: String,
) -> Result<Vec<crate::ollama_registry::RegistryModel>, String> {
    crate::ollama_registry::search(&query, 25)
        .await
        .map_err(|e| e.to_string())
}

/// Todas as variantes (tags) de um modelo do ollama.com, com tamanho/contexto.
#[tauri::command]
pub async fn ollama_registry_tags(
    model: String,
) -> Result<Vec<crate::ollama_registry::RegistryTag>, String> {
    crate::ollama_registry::fetch_tags(&model)
        .await
        .map_err(|e| e.to_string())
}

/// Lista modelos locais com metadados (para o hub "Modelos").
#[tauri::command]
pub async fn list_ollama_models_detailed(
    state: State<'_, AppState>,
) -> Result<Vec<providers::ollama::OllamaModel>, String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::list_models_detailed(&endpoint)
        .await
        .map_err(|e| e.to_string())
}

/// Apaga um modelo local.
#[tauri::command]
pub async fn delete_ollama_model(state: State<'_, AppState>, model: String) -> Result<(), String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    providers::ollama::delete_model(&endpoint, &model)
        .await
        .map_err(|e| e.to_string())
}

/// Testa um servidor MCP (handshake + tools/list) e devolve os nomes das tools.
#[tauri::command]
pub async fn test_mcp_server(
    config: crate::mcp::McpServerConfig,
) -> Result<Vec<String>, String> {
    crate::mcp::test_server(&config)
        .await
        .map_err(|e| e.to_string())
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind")]
pub enum PullEvent {
    Progress { status: String, percent: f64 },
    Done,
    Error { message: String },
}

#[tauri::command]
pub async fn pull_ollama_model(
    state: State<'_, AppState>,
    model: String,
    channel: Channel<PullEvent>,
) -> Result<(), String> {
    let endpoint = state.settings.lock().unwrap().ollama_endpoint.clone();
    let tx = channel.clone();
    let result = providers::ollama::pull_model(&endpoint, &model, move |status, percent| {
        let _ = tx.send(PullEvent::Progress {
            status: status.to_string(),
            percent,
        });
    })
    .await;
    match result {
        Ok(_) => {
            let _ = channel.send(PullEvent::Done);
            Ok(())
        }
        Err(e) => {
            let _ = channel.send(PullEvent::Error {
                message: e.to_string(),
            });
            Ok(())
        }
    }
}

// ---- LM Studio (modelos já descarregados, via REST local) ----
// Os downloads fazem-se na app do LM Studio; aqui só listamos para usar como provider de chat.
#[tauri::command]
pub async fn lmstudio_list(
    state: State<'_, AppState>,
) -> Result<Vec<crate::lmstudio::LmModel>, String> {
    let (endpoint, key) = {
        let s = state.settings.lock().unwrap();
        (s.openai_local_endpoint.clone(), s.openai_local_key.clone())
    };
    crate::lmstudio::list_downloaded(&endpoint, &key)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    messages: Vec<ChatMessage>,
) -> Result<ChatResponse, String> {
    // Clona as definições e larga o lock antes de qualquer await.
    let settings = state.settings.lock().unwrap().clone();

    let outcome = router::handle(&messages, &settings)
        .await
        .map_err(|e| e.to_string())?;

    let cost = router::outcome_cost(&outcome);

    // Atualiza a contabilidade.
    let snapshot = {
        let mut acc = state.accounting.lock().unwrap();
        match outcome.route {
            router::Route::Local => {
                let est = outcome.response.input_tokens + outcome.response.output_tokens;
                let est = if est == 0 {
                    estimate_tokens(&outcome.response.text)
                } else {
                    est
                };
                acc.record_local(est);
            }
            router::Route::Claude => {
                acc.record_claude(
                    &outcome.model,
                    outcome.response.input_tokens,
                    outcome.response.output_tokens,
                    outcome.response.reported_cost_usd,
                    outcome.tokens_saved_compression,
                );
            }
        }
        acc.clone()
    };

    Ok(ChatResponse {
        text: outcome.response.text,
        route: outcome.route.as_str().to_string(),
        model: outcome.model,
        input_tokens: outcome.response.input_tokens,
        output_tokens: outcome.response.output_tokens,
        tokens_saved: outcome.tokens_saved_compression,
        cost_usd: cost,
        reason: outcome.reason,
        accounting: snapshot,
    })
}

/// Interpreta "/nome args" no início de uma mensagem. Devolve (nome, args).
fn parse_slash_command(content: &str) -> Option<(String, String)> {
    let rest = content.trim().strip_prefix('/')?;
    if rest.is_empty() {
        return None;
    }
    let mut parts = rest.splitn(2, char::is_whitespace);
    let name = parts.next()?.to_string();
    let args = parts.next().unwrap_or("").trim().to_string();
    Some((name, args))
}

#[tauri::command]
pub async fn send_message_stream(
    state: State<'_, AppState>,
    conversation_id: i64,
    messages: Vec<ChatMessage>,
    channel: Channel<StreamEvent>,
    route_override: Option<String>,
    model_override: Option<String>,
    regenerate: bool,
    think_level: String,
    // Smart Saga (não-Plan-mode) pode virar `true` a meio da função, se o utilizador aceitar o
    // cartão de confirmação — o resto do código já condicionado a `research` aplica-se então só
    // a este turno, sem precisar de passagem de estado nova.
    mut research: bool,
    subagents: bool,
    plan: bool,
) -> Result<(), String> {
    let settings = state.settings.lock().unwrap().clone();

    // Regenerar: em vez de apagar a resposta anterior, marca-a "superseded" e liga a nova ao
    // mesmo version_group_id — dá para ciclar entre versões em vez de perder a anterior.
    let mut regen_version_group: Option<i64> = None;
    if regenerate {
        let conn = state.db.lock().unwrap();
        regen_version_group = store::supersede_last_assistant(&conn, conversation_id).unwrap_or(None);
    } else if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        // Persistir a mensagem do utilizador (a última do histórico) + auto-título.
        let attachments_json =
            serde_json::to_string(&last_user.attachments).unwrap_or_else(|_| "[]".into());
        let conn = state.db.lock().unwrap();
        let _ = store::append_message(
            &conn,
            conversation_id,
            "user",
            &last_user.content,
            &attachments_json,
            "",
            "",
            0,
            0,
            0.0,
            0,
            None,
        );
        let _ = store::maybe_autotitle(&conn, conversation_id, &last_user.content);
    }

    // Disparo de workflow: "/nome args" → carrega o procedimento e força a rota agêntica.
    let mut workflow_name: Option<String> = None;
    let mut workflow_system: Option<String> = None;
    if let Some(last_user) = messages.iter().rev().find(|m| m.role == "user") {
        if let Some((name, args)) = parse_slash_command(&last_user.content) {
            // Workflow desativado → ignora o disparo (segue como mensagem normal).
            if crate::workspace::is_enabled(&settings.workspace_dir, "workflow", &name) {
            if let Some(body) = crate::workspace::read_workflow(&settings.workspace_dir, &name) {
                let proc = body.replace("$ARGUMENTS", &args);
                workflow_system = Some(format!(
                    "Estás a executar o workflow '{name}'. Segue este procedimento usando as \
                     ferramentas disponíveis, regista o progresso e termina com um resumo curto.\n\n{proc}"
                ));
                workflow_name = Some(name);
            }
            }
        }
    }
    let forced_workflow = workflow_system.is_some();
    // Workflow `route: claude` força o Claude; `route: local` (default) segue a rota do utilizador.
    let workflow_route = workflow_name
        .as_deref()
        .map(|n| crate::workspace::doc_route(&settings.workspace_dir, "workflow", n))
        .unwrap_or_else(|| "local".to_string());
    let route_override_eff = if forced_workflow && workflow_route == "claude" {
        Some("claude".to_string())
    } else {
        route_override.clone()
    };

    // Contexto do tópico da conversa (brief + notas) — anteposto verbatim ao system prompt.
    let topic = {
        let conn = state.db.lock().unwrap();
        store::get_topic_for_conversation(&conn, conversation_id)
    };
    // Nome do tópico → scope do Workspace (docs `topic:` só ativam no seu tópico).
    let topic_name: Option<String> = topic
        .as_ref()
        .map(|t| t.name.trim().to_string())
        .filter(|s| !s.is_empty());
    // Projeto: pasta + se a edição é permitida (file tools na rota Claude — ver Dispatcher abaixo).
    let project_root: Option<String> = topic
        .as_ref()
        .map(|t| t.folder_path.trim().to_string())
        .filter(|s| !s.is_empty());
    let project_writable = topic
        .as_ref()
        .map(|t| t.permission_mode == "ask")
        .unwrap_or(false);
    // Sabemos já se as file tools vão estar disponíveis neste turno — para o modelo não alucinar
    // "sou uma IA sem acesso". Rota Claude (loop agêntico, API) OU rota local (Ollama, sem deep-research).
    let turn_has_image = messages
        .iter()
        .any(|m| m.attachments.iter().any(|a| a.kind == "image"));
    let route_claude_now = route_override_eff.as_deref() == Some("claude");
    // Modo CLI (subscrição) também tem tools de projeto agora (Read/Glob/Grep sempre;
    // Write/Edit se o tópico for editável — ver providers::claude_cli::run), por isso conta
    // como "tools on" tal como a API.
    let project_tools_on = project_root.is_some()
        && !turn_has_image
        && ((route_claude_now
            && settings.cloud_provider != "openai"
            && (settings.claude_mode == "api" || settings.claude_mode == "cli"))
            || (!route_claude_now && settings.local_provider != "openai" && !research));
    let topic_ctx = topic.map(|tp| {
        let mut block = format!("## Tópico: {}", tp.name);
        let brief = tp.brief.trim();
        let notes = tp.notes.trim();
        if !brief.is_empty() {
            block.push_str(&format!("\n{brief}"));
        }
        if !notes.is_empty() {
            block.push_str(&format!("\n\nNotas do tópico:\n{notes}"));
        }
        // Projeto: anexa a árvore da pasta ao contexto (leitura; as file tools são da rota Claude).
        let folder = tp.folder_path.trim();
        if !folder.is_empty() {
            let tree = crate::tools::project::tree_text(folder, 400);
            if !tree.trim().is_empty() {
                block.push_str(&format!(
                    "\n\n## Projeto (pasta): {folder}\nÁrvore de ficheiros (parcial):\n{tree}"
                ));
            }
            if project_tools_on && route_claude_now && settings.claude_mode == "cli" {
                // Modo CLI: as tools reais (Read/Glob/Grep/Write/Edit) e o texto sobre confirmação
                // (ou falta dela) são injetados por providers::claude_cli::run via
                // --append-system-prompt — aqui só confirmamos que existem, sem repetir detalhes
                // que podem ficar desatualizados nos dois sítios.
                block.push_str(
                    "\n\nTens ferramentas de ficheiro nesta pasta (Read/Glob/Grep sempre; Write/Edit se o \
                     projeto estiver em 'Edição confirmada') — usa-as, não inventes que não tens acesso.",
                );
            } else if project_tools_on {
                block.push_str(
                    "\n\nTens ferramentas de ficheiro neste projeto: usa project_tree e project_read para explorar, e project_edit/project_create para gravar (cada gravação é confirmada pelo utilizador). Usa caminhos relativos à pasta.",
                );
            } else {
                // Sem tools este turno → o modelo deve explicar a condição, não inventar que não tem acesso.
                let extra = if project_writable {
                    "criar/editar"
                } else {
                    "ler sob demanda"
                };
                block.push_str(&format!(
                    "\n\n[IMPORTANTE] Tens a árvore acima como contexto, mas NESTA conversa NÃO tens ferramentas para aceder aos ficheiros. Para {extra} ficheiros do projeto, diz ao utilizador para enviar na rota \"Claude\" (API ou CLI) — só aí o agente tem acesso ao sistema de ficheiros. NÃO afirmes que és uma IA sem acesso a ficheiros nem mandes copiar/colar para um ficheiro manualmente; explica esta condição concreta.",
                ));
            }
        }
        router::TopicCtx { name: tp.name, block }
    });

    let mut prepared = router::prepare(
        &messages,
        &settings,
        route_override_eff.as_deref(),
        model_override.as_deref(),
        topic_ctx.as_ref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    if let Some(sys) = workflow_system {
        prepared.full_messages.insert(
            0,
            ChatMessage {
                role: "system".into(),
                content: sys,
                attachments: Vec::new(),
            },
        );
    }

    let local_openai = settings.local_provider == "openai";
    let cloud_openai = settings.cloud_provider == "openai";
    // Modelo realmente usado (do slot ativo), para badge/contabilidade.
    let effective_model = match prepared.route {
        router::Route::Local if local_openai => settings.openai_local_model.clone(),
        router::Route::Claude if cloud_openai => settings.openai_cloud_model.clone(),
        _ => prepared.model.clone(),
    };

    // Breadcrumb: contexto do turno (útil para ver a última ação antes de um crash).
    log::info!(
        "turn conv={conversation_id} route={} model={effective_model} research={research} subagents={subagents} think={think_level} msgs={} images={} web_search={}",
        prepared.route.as_str(),
        prepared.full_messages.len(),
        prepared.has_images,
        settings.local_web_search || research
    );

    let _ = channel.send(StreamEvent::Start {
        route: prepared.route.as_str().to_string(),
        model: effective_model.clone(),
        reason: prepared.reason.clone(),
    });

    // Acumulador do texto gerado — persiste o parcial se o utilizador carregar em "Parar".
    let acc_buf = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    // Closure que reenvia cada fragmento para o frontend (e acumula para o cancelamento).
    let tx = channel.clone();
    let acc_delta = acc_buf.clone();
    let on_delta = move |d: &str| {
        if let Ok(mut g) = acc_delta.lock() {
            g.push_str(d);
        }
        let _ = tx.send(StreamEvent::Delta {
            text: d.to_string(),
        });
    };

    let gen_start = std::time::Instant::now();
    // Tokens do gate de clarificação do chat (B), somados ao turno depois (0 no Plan mode).
    let mut clarify_in = 0u64;
    let mut clarify_out = 0u64;
    // Concordância das amostras no modo Think "verify" (None = sem verify).
    let mut turn_confidence: Option<f32> = None;
    // Nível Think que realmente corre: verify/debate só no chat local simples; senão degrada a "think".
    let mut think_used = match think_level.as_str() {
        "verify" | "debate" => "think".to_string(),
        other => other.to_string(),
    };
    // Camada "reasoning": intenção do pedido (determinística). Alimenta o deep-research e a metadata.
    let turn_intent = crate::reasoning::classify_intent(
        messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map(|m| m.content.as_str())
            .unwrap_or(""),
    );
    log::info!(
        "[clarify] nivel={} intent={turn_intent:?} (plan={plan}, regen={regenerate})",
        settings.clarify_level
    );
    // Canal de cancelamento: o botão "Parar" (cancel_generation) dispara-o e o select! abaixo
    // termina a geração, preservando o texto já acumulado.
    let (cancel_tx, mut cancel_rx) = oneshot::channel::<()>();
    state.cancels.lock().unwrap().insert(conversation_id, cancel_tx);
    let gen_fut = async {
        // Rota local: só uma geração de cada vez em toda a app (ver AppState.local_gen) — espera
        // aqui a vez, sem bloquear a UI de outras conversas. Rota Claude nunca espera por isto.
        let _local_gen_permit = if prepared.route == router::Route::Local {
            Some(state.local_gen.lock().await)
        } else {
            None
        };
        if plan {
        // Plan mode: planeia → aprova/edita → executa passo a passo (planner orquestra; 🔎 fundamenta).
        let use_api = prepared.route == router::Route::Claude;
        let plan_gopts = providers::ollama::GenOpts {
            num_ctx: effective_num_ctx(settings.ollama_num_ctx, &prepared.full_messages),
            temperature: settings.ollama_temp_opt(),
            num_predict: None,
        };
        let tx_step = channel.clone();
        let on_step = move |i: usize, status: &str| {
            let _ = tx_step.send(StreamEvent::PlanStep {
                index: i as u32,
                status: status.to_string(),
            });
        };
        let searches = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
        let sc = searches.clone();
        let tx_tool = channel.clone();
        let on_tool = move |tool: &str, detail: &str| {
            if tool == "web_search" {
                sc.fetch_add(1, Ordering::Relaxed);
            }
            let _ = tx_tool.send(StreamEvent::ToolStep {
                tool: tool.to_string(),
                detail: detail.to_string(),
            });
        };
        let tx_plan = channel.clone();
        let st = state.inner();
        // Aprovação do plano: emite o evento Plan (com needs_web + o estado atual do 🔎) e bloqueia
        // até a UI responder com os passos editados e a decisão de fundamentar na web.
        let research_now = research;
        let approve = move |steps: Vec<String>, needs_web: bool| async move {
            let id = st.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let (txo, rxo) = oneshot::channel();
            st.pending_plans.lock().await.insert(id, txo);
            let _ = tx_plan.send(StreamEvent::Plan { id, steps, needs_web, research: research_now });
            rxo.await.unwrap_or(None)
        };
        // Esclarecimento: emite as perguntas e bloqueia até a UI responder (respostas por pergunta).
        let tx_clarify = channel.clone();
        let clarify_model = prepared.model.clone();
        let ask = move |questions: Vec<String>| async move {
            let id = st.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let (txo, rxo) = oneshot::channel();
            st.pending_clarify.lock().await.insert(id, (txo, clarify_model));
            let _ = tx_clarify.send(StreamEvent::Clarify { id, questions });
            rxo.await.unwrap_or(None)
        };
        let r = crate::planner::run(
            &settings,
            use_api,
            &prepared.model,
            &prepared.full_messages,
            plan_gopts,
            &settings.clarify_level,
            ask,
            approve,
            on_step,
            on_delta,
            on_tool,
        )
        .await;
        // Contabiliza as pesquisas dos passos fundamentados (medidor de uso mensal).
        let n = searches.load(Ordering::Relaxed);
        if n > 0 {
            let eff = if settings.web_search_provider != "duckduckgo"
                && settings.active_web_key().trim().is_empty()
            {
                "duckduckgo"
            } else {
                settings.web_search_provider.as_str()
            };
            let ym = chrono::Local::now().format("%Y-%m").to_string();
            let conn = state.db.lock().unwrap();
            let _ = store::add_search_usage(&conn, &ym, eff, n);
        }
        r
    } else {
    // Skills acionadas por trigger (rota local): mostra "Skill aplicada: X" no chat antes de responder.
    for name in &prepared.skills_applied {
        let _ = channel.send(StreamEvent::ToolStep {
            tool: "skill".to_string(),
            detail: name.clone(),
        });
    }
    // Clarificação no chat (cascata A→B por `clarify_level`). Não corre em regenerar, workflow forçado,
    // turno com imagem, ou nível off. As perguntas vão pelo MESMO cartão/evento do Plan mode.
    let latest_user_has_image = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.attachments.iter().any(|a| a.kind == "image"))
        .unwrap_or(false);
    if !regenerate && !forced_workflow && settings.clarify_level != "off" && !latest_user_has_image {
        let is_followup = messages.iter().any(|m| m.role == "assistant");
        let use_api = prepared.route == router::Route::Claude;
        let gate_opts = providers::ollama::GenOpts {
            num_ctx: effective_num_ctx(settings.ollama_num_ctx, &prepared.full_messages),
            temperature: settings.ollama_temp_opt(),
            num_predict: Some(256),
        };
        let qs = crate::clarify::gate(
            &settings,
            use_api,
            &prepared.model,
            &prepared.full_messages,
            &settings.clarify_level,
            is_followup,
            gate_opts,
            &mut clarify_in,
            &mut clarify_out,
        )
        .await;
        if !qs.is_empty() {
            let id = state.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
            let (txo, rxo) = oneshot::channel();
            state.pending_clarify.lock().await.insert(id, (txo, prepared.model.clone()));
            let _ = channel.send(StreamEvent::Clarify { id, questions: qs.clone() });
            if let Some(answers) = rxo.await.unwrap_or(None) {
                let qa = qs
                    .iter()
                    .zip(answers.iter())
                    .filter(|(_, a)| !a.trim().is_empty())
                    .map(|(q, a)| format!("- {q} {}", a.trim()))
                    .collect::<Vec<_>>()
                    .join("\n");
                if !qa.is_empty() {
                    prepared.full_messages = crate::planner::with_instruction(
                        &prepared.full_messages,
                        &format!("Esclarecimentos que dei:\n{qa}"),
                    );
                }
            }
        }
    }
    // Smart Saga (chat normal, fora do Plan mode): o pedido parece precisar de dados atuais e
    // este turno ainda não tem acesso à web? Pergunta antes de decidir sozinho — nunca pesquisa
    // às escondas nem responde de cabeça algo que pode estar desatualizado. Detetor determinístico
    // e fail-CLOSED (`needs_web_confirm`): mesma filosofia do `wants_web` já usado no resto do
    // clarify.rs — nunca julgamento do próprio modelo (ver histórico do `needs_web_check` removido
    // do Plan mode por não ser fiável).
    if !regenerate
        && !forced_workflow
        && !latest_user_has_image
        && settings.smart_web_confirm
        && !research
    {
        let capable = match prepared.route {
            router::Route::Local => !local_openai,
            router::Route::Claude => !cloud_openai,
        };
        if capable {
            let task = messages
                .iter()
                .rev()
                .find(|m| m.role == "user")
                .map(|m| m.content.trim().to_string())
                .unwrap_or_default();
            if let Some(signal) = crate::clarify::needs_web_confirm(&task) {
                // Já tem acesso à web este turno por outra via → perguntar seria só fricção.
                let already_has_web = settings.local_web_search
                    || project_root.is_some()
                    || (prepared.route == router::Route::Claude
                        && settings.claude_mode == "api"
                        && (settings.enable_browser_tools
                            || settings
                                .mcp_servers
                                .iter()
                                .any(|s| s.enabled && !s.name.trim().is_empty())
                            || {
                                let idx = crate::workspace::index(&settings.workspace_dir)
                                    .active(topic_name.as_deref());
                                !idx.skills.is_empty() || !idx.playbooks.is_empty()
                            }));
                if !already_has_web {
                    let id = state.approval_seq.fetch_add(1, Ordering::Relaxed) + 1;
                    let (txo, rxo) = oneshot::channel();
                    state.pending_search.lock().await.insert(id, txo);
                    let hint = format!(
                        "Isto parece precisar de dados atuais (\"{signal}\") — queres que eu pesquise na web antes de responder?"
                    );
                    let _ = channel.send(StreamEvent::SearchConfirm { id, hint });
                    if rxo.await.unwrap_or(false) {
                        research = true;
                    } else {
                        prepared.full_messages = crate::planner::with_instruction(
                            &prepared.full_messages,
                            "Não tens acesso à web neste turno. Se a resposta depender de dados \
atuais de que não tens a certeza, di-lo claramente em vez de arriscar um palpite desatualizado.",
                        );
                    }
                }
            }
        }
    }
    match prepared.route {
        router::Route::Local if local_openai => {
            providers::openai_compat::chat_stream(
                &settings.openai_local_endpoint,
                &settings.openai_local_key,
                &settings.openai_local_model,
                &prepared.full_messages,
                settings.claude_max_tokens,
                on_delta,
            )
            .await
        }
        router::Route::Local => {
            // Janela adaptativa: garante espaço para a resposta mesmo com prompts grandes
            // (ex.: documentos anexados). Senão a resposta corta-se a meio.
            let num_ctx = effective_num_ctx(settings.ollama_num_ctx, &prepared.full_messages);
            log::info!(
                "local num_ctx base={} efetivo={num_ctx}",
                settings.ollama_num_ctx
            );
            let gopts = providers::ollama::GenOpts {
                num_ctx,
                temperature: settings.ollama_temp_opt(),
                num_predict: None,
            };
            // 🔎 explícito (research) → pipeline FUNDAMENTADA (decompõe → pesquisa → verifica → sintetiza).
            // Pesquisa web passiva (sempre-ligada) OU projeto com pasta → loop leve (web_agent, com tools).
            // Sem nada disto, segue para o chat/visão direto (chat_stream) abaixo.
            if settings.local_web_search || research || project_root.is_some() {
                let tx_t = channel.clone();
                // Conta as pesquisas web feitas neste pedido (para o medidor de uso mensal).
                let searches = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
                let sc = searches.clone();
                let on_tool = move |tool: &str, detail: &str| {
                    if tool == "web_search" {
                        sc.fetch_add(1, Ordering::Relaxed);
                    }
                    let _ = tx_t.send(StreamEvent::ToolStep {
                        tool: tool.to_string(),
                        detail: detail.to_string(),
                    });
                };
                let r = if research {
                    crate::deep_research::run(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &settings.web_search_provider,
                        &settings.active_web_key(),
                        &prepared.full_messages,
                        turn_intent,
                        gopts,
                        settings.research_max_rounds,
                        on_delta,
                        on_tool,
                    )
                    .await
                } else {
                    // Projeto (pasta): file tools com confirmação na rota local. Reusa o gate/Approver
                    // da rota Claude (ask + action_log + cartão de aprovação no chat).
                    let approver = ChannelApprover {
                        channel: channel.clone(),
                        state: state.inner(),
                    };
                    let mode = if project_writable && settings.confirm_mode == "off" {
                        ConfirmMode::Ask
                    } else {
                        ConfirmMode::parse(&settings.confirm_mode)
                    };
                    let project_tools = project_root.as_ref().map(|root| {
                        crate::tools::dispatch::ProjectTools {
                            root: root.clone(),
                            writable: project_writable,
                        }
                    });
                    let gate = ActionGate {
                        db: Some(&state.db),
                        conversation_id,
                        mode,
                        approver: if mode == ConfirmMode::Ask {
                            Some(&approver)
                        } else {
                            None
                        },
                    };
                    crate::web_agent::run(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &settings.web_search_provider,
                        &settings.active_web_key(),
                        &prepared.full_messages,
                        &settings.workspace_dir,
                        &prepared.skills_applied,
                        topic_name.as_deref(),
                        project_tools.as_ref(),
                        Some(&gate),
                        gopts,
                        on_delta,
                        on_tool,
                    )
                    .await
                };
                // Atribui ao motor que REALMENTE correu (sem chave, um motor com chave cai p/ DDG).
                let n = searches.load(Ordering::Relaxed);
                if n > 0 {
                    let eff = if settings.web_search_provider != "duckduckgo"
                        && settings.active_web_key().trim().is_empty()
                    {
                        "duckduckgo"
                    } else {
                        settings.web_search_provider.as_str()
                    };
                    let ym = chrono::Local::now().format("%Y-%m").to_string();
                    let conn = state.db.lock().unwrap();
                    let _ = store::add_search_usage(&conn, &ym, eff, n);
                }
                r
            } else {
                // Escala Think na rota local: verify = self-consistency (amostra + concordância +
                // síntese); senão raciocínio nativo (off suprime-o).
                if think_level == "verify" {
                    let tx_t = channel.clone();
                    let on_tool = move |tool: &str, detail: &str| {
                        let _ = tx_t.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    };
                    match crate::think::self_consistency(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &prepared.full_messages,
                        gopts,
                        3,
                        on_delta,
                        on_tool,
                    )
                    .await
                    {
                        Ok((resp, conf)) => {
                            turn_confidence = conf;
                            think_used = "verify".to_string();
                            Ok(resp)
                        }
                        Err(e) => Err(e),
                    }
                } else if think_level == "debate" {
                    think_used = "debate".to_string();
                    let tx_t = channel.clone();
                    let on_tool = move |tool: &str, detail: &str| {
                        let _ = tx_t.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    };
                    crate::think::debate(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &prepared.full_messages,
                        gopts,
                        on_delta,
                        on_tool,
                    )
                    .await
                } else {
                    // Modelos com raciocínio (gemma4, qwen3, deepseek-r1…) emitem "thinking"
                    // separado — só o pedimos se o nível Think estiver ligado (off suprime-o).
                    let think =
                        think_level != "off" && providers::ollama::model_reasons(&prepared.model);
                    let tx_think = channel.clone();
                    providers::ollama::chat_stream(
                        &settings.ollama_endpoint,
                        &prepared.model,
                        &prepared.full_messages,
                        gopts,
                        think,
                        on_delta,
                        move |t| {
                            let _ = tx_think.send(StreamEvent::Thinking { text: t.to_string() });
                        },
                    )
                    .await
                }
            }
        }
        router::Route::Claude if cloud_openai => {
            providers::openai_compat::chat_stream(
                &settings.openai_cloud_endpoint,
                &settings.openai_cloud_key,
                &settings.openai_cloud_model,
                &prepared.full_messages,
                settings.claude_max_tokens,
                on_delta,
            )
            .await
        }
        router::Route::Claude => {
            // CLI e API leem imagens (a CLI via ficheiros temporários + tool Read).
            let use_api = settings.claude_mode == "api";
            let any_mcp = settings
                .mcp_servers
                .iter()
                .any(|s| s.enabled && !s.name.trim().is_empty());
            // Só os itens ativos chegam ao Dispatcher (manifesto + tools load_skill/read_playbook).
            let ws_index =
                crate::workspace::index(&settings.workspace_dir).active(topic_name.as_deref());
            let has_ws = !ws_index.skills.is_empty() || !ws_index.playbooks.is_empty();
            let want_tools = use_api
                && !prepared.has_images
                && (settings.enable_browser_tools
                    || any_mcp
                    || has_ws
                    || forced_workflow
                    || project_root.is_some());
            // O orquestrador de subagentes (abaixo) não tem acesso a ferramentas — se este turno já
            // tem ferramentas disponíveis (browser/MCP/workspace/projeto), elas têm prioridade e o
            // toggle Subagentes fica sem efeito. Sem isto o utilizador via a UI ligada sem saber
            // porque é que nada mudou — avisa em vez de ficar silencioso.
            if subagents && want_tools {
                let _ = channel.send(StreamEvent::ToolStep {
                    tool: "subagents_skipped".to_string(),
                    detail: String::new(),
                });
            }
            if want_tools {
                // Loop agêntico com ferramentas (browser e/ou servidores MCP) — só API.
                let tx_d = channel.clone();
                let tx_t = channel.clone();

                // Lança o browser se ativado.
                let mut browser_guard = state.browser.lock().await;
                if settings.enable_browser_tools && browser_guard.is_none() {
                    match PlaywrightSidecar::spawn(
                        &settings.browser_node_path,
                        &settings.browser_sidecar_script,
                        &settings.browser_user_data_dir,
                    )
                    .await
                    {
                        Ok(s) => *browser_guard = Some(s),
                        Err(e) => return Err(anyhow::anyhow!("{e}")),
                    }
                }
                // Garante os servidores MCP ativos.
                let mut mcp_guard = state.mcp.lock().await;
                if any_mcp {
                    mcp_guard.ensure_ready(&settings.mcp_servers).await;
                }

                // Workflows e projetos editáveis fazem ações: se a confirmação estiver desligada,
                // pede aprovação na mesma (nunca grava ficheiros sem confirmar).
                let mode = if (forced_workflow || project_writable) && settings.confirm_mode == "off" {
                    ConfirmMode::Ask
                } else {
                    ConfirmMode::parse(&settings.confirm_mode)
                };
                if let Some(name) = &workflow_name {
                    let _ = channel.send(StreamEvent::ToolStep {
                        tool: "workflow".into(),
                        detail: name.clone(),
                    });
                }
                let approver = ChannelApprover {
                    channel: channel.clone(),
                    state: state.inner(),
                };
                let mut dispatcher = Dispatcher {
                    browser: if settings.enable_browser_tools {
                        browser_guard.as_mut()
                    } else {
                        None
                    },
                    mcp: if any_mcp { Some(&mut *mcp_guard) } else { None },
                    workspace: if has_ws {
                        Some(crate::tools::dispatch::WorkspaceTools {
                            dir: &settings.workspace_dir,
                            index: &ws_index,
                        })
                    } else {
                        None
                    },
                    project: project_root.as_ref().map(|root| {
                        crate::tools::dispatch::ProjectTools {
                            root: root.clone(),
                            writable: project_writable,
                        }
                    }),
                    gate: ActionGate {
                        db: Some(&state.db),
                        conversation_id,
                        mode,
                        approver: if mode == ConfirmMode::Ask {
                            Some(&approver)
                        } else {
                            None
                        },
                    },
                };
                agent::run(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    &mut dispatcher,
                    move |d| {
                        let _ = tx_d.send(StreamEvent::Delta { text: d.to_string() });
                    },
                    move |tool, detail| {
                        let _ = tx_t.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else if use_api && subagents {
                // Orquestração de subagentes (planeador → paralelo → síntese).
                let tx_tool = channel.clone();
                crate::orchestrator::orchestrate(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    research,
                    settings.research_max_rounds,
                    on_delta,
                    move |tool, detail| {
                        let _ = tx_tool.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else if use_api {
                let thinking_budget = if think_level != "off" {
                    Some(settings.thinking_budget)
                } else {
                    None
                };
                let tx_think = channel.clone();
                let tx_tool = channel.clone();
                providers::claude_api::messages_stream(
                    &settings.claude_api_key,
                    &prepared.model,
                    settings.claude_max_tokens,
                    &prepared.full_messages,
                    thinking_budget,
                    research,
                    on_delta,
                    move |th| {
                        let _ = tx_think.send(StreamEvent::Thinking {
                            text: th.to_string(),
                        });
                    },
                    move |tool, detail| {
                        let _ = tx_tool.send(StreamEvent::ToolStep {
                            tool: tool.to_string(),
                            detail: detail.to_string(),
                        });
                    },
                )
                .await
            } else {
                // CLI não suporta streaming fino — resposta completa, emitida como um delta.
                let mut cli_tools: Vec<&str> = Vec::new();
                if research {
                    cli_tools.push("WebSearch");
                    cli_tools.push("WebFetch");
                }
                if subagents {
                    cli_tools.push("Task");
                }
                // Modo CLI corre fora do Dispatcher do Saga (a própria CLI usa as suas tools
                // nativas) — não há eventos de tool-call para registar. Em vez disso, comparamos
                // a pasta antes/depois: é a única forma de saber o que mudou e deixar um rasto
                // no Action Log (ver tools/project::{snapshot,diff_snapshots}).
                let write_snapshot = if project_writable {
                    project_root
                        .as_ref()
                        .map(|r| crate::tools::project::snapshot(r, 500))
                } else {
                    None
                };
                let r = providers::claude_cli::run(
                    &settings.claude_cli_path,
                    &prepared.model,
                    &prepared.full_messages,
                    &cli_tools,
                    project_root.as_ref().map(|r| (r.as_str(), project_writable)),
                )
                .await;
                if let (Some(before), Some(root)) = (&write_snapshot, &project_root) {
                    let after = crate::tools::project::snapshot(root, 500);
                    let changed = crate::tools::project::diff_snapshots(before, &after);
                    if !changed.is_empty() {
                        let conn = state.db.lock().unwrap();
                        let _ = store::insert_action(
                            &conn,
                            conversation_id,
                            "claude_cli_write",
                            &serde_json::json!({ "files": changed }).to_string(),
                            "OK",
                            &changed.join(", "),
                            "",
                        );
                    }
                }
                if let Ok(ref resp) = r {
                    let _ = channel.send(StreamEvent::Delta {
                        text: resp.text.clone(),
                    });
                }
                r
            }
        }
    }
    } };
    // Corre a geração contra o cancelamento. Se o utilizador parar, mantemos o parcial já gerado.
    let outcome = {
        tokio::pin!(gen_fut);
        tokio::select! {
            r = &mut gen_fut => Some(r),
            _ = &mut cancel_rx => None,
        }
    };
    state.cancels.lock().unwrap().remove(&conversation_id);
    let response = match outcome {
        Some(r) => r.map_err(|e| e.to_string())?,
        None => {
            // Cancelado: persiste o texto já produzido (se houver) e finaliza limpo com um Done.
            let gen_ms = gen_start.elapsed().as_millis() as i64;
            let partial = acc_buf.lock().map(|g| g.clone()).unwrap_or_default();
            let mut mid = 0i64;
            let mut version = (0i64, 1i64, 1i64);
            if !partial.trim().is_empty() {
                let conn = state.db.lock().unwrap();
                if let Ok(m) = store::append_message(
                    &conn,
                    conversation_id,
                    "assistant",
                    &partial,
                    "[]",
                    prepared.route.as_str(),
                    &effective_model,
                    0,
                    0,
                    0.0,
                    prepared.tokens_saved as i64,
                    regen_version_group,
                ) {
                    let _ = store::set_message_gen_ms(&conn, m, gen_ms);
                    mid = m;
                    version = store::version_info(&conn, m).unwrap_or((m, 1, 1));
                }
            }
            let snapshot = state.accounting.lock().unwrap().clone();
            let _ = channel.send(StreamEvent::Done {
                message_id: mid,
                version_group_id: version.0,
                version_count: version.1,
                version_index: version.2,
                input_tokens: 0,
                output_tokens: 0,
                tokens_saved: prepared.tokens_saved,
                cost_usd: 0.0,
                gen_ms,
                intent: turn_intent.as_str().to_string(),
                think_level: think_used,
                confidence: None,
                accounting: snapshot,
            });
            return Ok(());
        }
    };
    let gen_ms = gen_start.elapsed().as_millis() as i64;

    // Pesquisa numa só passagem (sem subagentes): acrescenta as fontes capturadas.
    let mut response = response;
    if research && !subagents && !response.sources.is_empty() {
        let mut fontes = String::from("\n\n## Fontes\n");
        for (i, s) in response.sources.iter().enumerate() {
            let label = if s.title.trim().is_empty() { &s.url } else { &s.title };
            fontes.push_str(&format!("{}. [{}]({})\n", i + 1, label, s.url));
        }
        let _ = channel.send(StreamEvent::Delta {
            text: fontes.clone(),
        });
        response.text.push_str(&fontes);
    }

    // Soma os tokens do gate de clarificação (B) ao turno (0 fora do chat / Plan mode).
    response.input_tokens += clarify_in;
    response.output_tokens += clarify_out;

    let snapshot = {
        let mut acc = state.accounting.lock().unwrap();
        match prepared.route {
            router::Route::Local => {
                let est = response.input_tokens + response.output_tokens;
                let est = if est == 0 {
                    estimate_tokens(&response.text)
                } else {
                    est
                };
                acc.record_local(est);
            }
            router::Route::Claude => {
                acc.record_claude(
                    &effective_model,
                    response.input_tokens,
                    response.output_tokens,
                    response.reported_cost_usd,
                    prepared.tokens_saved,
                );
            }
        }
        acc.clone()
    };

    let cost = if prepared.route == router::Route::Claude {
        if response.reported_cost_usd > 0.0 {
            response.reported_cost_usd
        } else {
            crate::accounting::cost_usd(
                &effective_model,
                response.input_tokens,
                response.output_tokens,
            )
        }
    } else {
        0.0
    };

    // Persistir a resposta do assistente (+ tempo de geração).
    let mut assistant_mid: i64 = 0;
    let mut version = (0i64, 1i64, 1i64);
    {
        let conn = state.db.lock().unwrap();
        if let Ok(mid) = store::append_message(
            &conn,
            conversation_id,
            "assistant",
            &response.text,
            "[]",
            prepared.route.as_str(),
            &effective_model,
            response.input_tokens as i64,
            response.output_tokens as i64,
            cost,
            prepared.tokens_saved as i64,
            regen_version_group,
        ) {
            let _ = store::set_message_gen_ms(&conn, mid, gen_ms);
            assistant_mid = mid;
            version = store::version_info(&conn, mid).unwrap_or((mid, 1, 1));
        }
    }

    let _ = channel.send(StreamEvent::Done {
        message_id: assistant_mid,
        version_group_id: version.0,
        version_count: version.1,
        version_index: version.2,
        input_tokens: response.input_tokens,
        output_tokens: response.output_tokens,
        tokens_saved: prepared.tokens_saved,
        cost_usd: cost,
        gen_ms,
        intent: turn_intent.as_str().to_string(),
        think_level: think_used,
        confidence: turn_confidence,
        accounting: snapshot,
    });

    Ok(())
}
