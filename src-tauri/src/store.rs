//! Persistência de conversas e mensagens em SQLite (rusqlite, bundled).

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::accounting::Accounting;
use crate::settings;

#[derive(Serialize)]
pub struct ConversationMeta {
    pub id: i64,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
    /// Tópico a que a conversa pertence (NULL = sem tópico).
    pub topic_id: Option<i64>,
}

#[derive(Serialize)]
pub struct Topic {
    pub id: i64,
    pub name: String,
    /// Brief partilhado por todos os chats do tópico (injetado no contexto — Fase 2).
    pub brief: String,
    /// Notas fixadas do tópico (também injetadas no contexto — Fase 2).
    pub notes: String,
    /// Pasta do projeto (vazio = não é projeto). Dá file tools + árvore no contexto.
    pub folder_path: String,
    /// Permissão das file tools: "read" (só leitura) | "ask" (editar com confirmação).
    pub permission_mode: String,
}

#[derive(Serialize)]
pub struct StoredMessage {
    pub id: i64,
    pub role: String,
    pub content: String,
    pub attachments_json: String,
    pub route: String,
    pub model: String,
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cost_usd: f64,
    pub tokens_saved: i64,
    /// Tempo de geração da resposta (ms). 0 = desconhecido (ex.: mensagens do utilizador).
    pub gen_ms: i64,
    /// Passos de ferramenta (breadcrumbs "usou skill X", "pesquisou Y") em JSON `["…"]`. '[]' = nenhum.
    pub steps_json: String,
}

/// Abre (ou cria) a base de dados em `<config>/saga/saga.db` e garante o schema.
pub fn open() -> Result<Connection> {
    let dir = settings::config_dir();
    std::fs::create_dir_all(&dir).ok();
    let path = dir.join("saga.db");
    let conn = Connection::open(&path).with_context(|| format!("abrir DB em {path:?}"))?;
    conn.pragma_update(None, "foreign_keys", "ON").ok();
    init(&conn)?;
    Ok(conn)
}

fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS conversations (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            title      TEXT NOT NULL DEFAULT 'Nova conversa',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS messages (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id  INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
            role             TEXT NOT NULL,
            content          TEXT NOT NULL,
            attachments_json TEXT NOT NULL DEFAULT '[]',
            route            TEXT NOT NULL DEFAULT '',
            model            TEXT NOT NULL DEFAULT '',
            input_tokens     INTEGER NOT NULL DEFAULT 0,
            output_tokens    INTEGER NOT NULL DEFAULT 0,
            cost_usd         REAL NOT NULL DEFAULT 0,
            tokens_saved     INTEGER NOT NULL DEFAULT 0,
            created_at       TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
            content,
            conversation_id UNINDEXED,
            message_id UNINDEXED
        );
        CREATE TABLE IF NOT EXISTS action_log (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            conversation_id INTEGER NOT NULL,
            tool            TEXT NOT NULL,
            params_json     TEXT NOT NULL DEFAULT '',
            status          TEXT NOT NULL,
            detail          TEXT NOT NULL DEFAULT '',
            error           TEXT NOT NULL DEFAULT '',
            created_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_action_log_conv ON action_log(conversation_id);
        CREATE TABLE IF NOT EXISTS schedules (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            name           TEXT NOT NULL,
            workflow_name  TEXT NOT NULL,
            arguments      TEXT NOT NULL DEFAULT '',
            cron           TEXT NOT NULL,
            enabled        INTEGER NOT NULL DEFAULT 1,
            last_run_at    TEXT NOT NULL DEFAULT '',
            next_run_epoch INTEGER NOT NULL DEFAULT 0,
            created_at     TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS search_usage (
            ym       TEXT NOT NULL,
            provider TEXT NOT NULL,
            n        INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (ym, provider)
        );
        CREATE TABLE IF NOT EXISTS topics (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL DEFAULT '' COLLATE NOCASE,
            brief      TEXT NOT NULL DEFAULT '',
            notes      TEXT NOT NULL DEFAULT '',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_name ON topics(name COLLATE NOCASE);
        "#,
    )?;
    // Migração: agrupar conversas por tópico (sem FK — o ALTER do SQLite não a adiciona;
    // o SET NULL ao apagar um tópico é feito em código em delete_topic).
    conn.execute(
        "ALTER TABLE conversations ADD COLUMN topic_id INTEGER",
        [],
    )
    .ok();
    // Migração: um tópico pode ser um projeto (pasta + permissão das file tools).
    conn.execute(
        "ALTER TABLE topics ADD COLUMN folder_path TEXT NOT NULL DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE topics ADD COLUMN permission_mode TEXT NOT NULL DEFAULT 'read'",
        [],
    )
    .ok();
    // Migração: colunas de compactação na conversa (ignora erro se já existirem).
    conn.execute(
        "ALTER TABLE conversations ADD COLUMN compacted_summary TEXT NOT NULL DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE conversations ADD COLUMN compacted_upto INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();
    // Migração: tempo de geração por mensagem (ms).
    conn.execute(
        "ALTER TABLE messages ADD COLUMN gen_ms INTEGER NOT NULL DEFAULT 0",
        [],
    )
    .ok();
    // Migração: breadcrumbs de ferramentas por mensagem (persistem entre reinícios).
    conn.execute(
        "ALTER TABLE messages ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]'",
        [],
    )
    .ok();
    // Migração: resultado da última execução de cada agendamento (estado + erro), para a vista de Automações.
    conn.execute(
        "ALTER TABLE schedules ADD COLUMN last_status TEXT NOT NULL DEFAULT ''",
        [],
    )
    .ok();
    conn.execute(
        "ALTER TABLE schedules ADD COLUMN last_error TEXT NOT NULL DEFAULT ''",
        [],
    )
    .ok();
    // Backfill único do índice de pesquisa, se ainda estiver vazio.
    let fts_count: i64 = conn
        .query_row("SELECT count(*) FROM messages_fts", [], |r| r.get(0))
        .unwrap_or(0);
    let msg_count: i64 = conn
        .query_row("SELECT count(*) FROM messages", [], |r| r.get(0))
        .unwrap_or(0);
    if fts_count == 0 && msg_count > 0 {
        conn.execute(
            "INSERT INTO messages_fts(content, conversation_id, message_id)
             SELECT content, conversation_id, id FROM messages",
            [],
        )?;
    }
    Ok(())
}

#[derive(Serialize)]
pub struct SearchHit {
    pub conversation_id: i64,
    pub title: String,
    pub snippet: String,
}

/// Pesquisa full-text nas mensagens; devolve conversas com um excerto.
pub fn search_messages(conn: &Connection, query: &str) -> Result<Vec<SearchHit>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    // Pesquisa por frase (aspas), escapando aspas para não partir a sintaxe FTS5.
    let match_expr = format!("\"{}\"", q.replace('"', "\"\""));
    let mut stmt = conn.prepare(
        "SELECT f.conversation_id, c.title,
                snippet(messages_fts, 0, '[', ']', '…', 10) AS snip
         FROM messages_fts f
         JOIN conversations c ON c.id = f.conversation_id
         WHERE messages_fts MATCH ?1
         ORDER BY rank
         LIMIT 50",
    )?;
    let rows = stmt.query_map(params![match_expr], |r| {
        Ok(SearchHit {
            conversation_id: r.get(0)?,
            title: r.get(1)?,
            snippet: r.get(2)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn create_conversation(conn: &Connection, title: &str, topic_id: Option<i64>) -> Result<i64> {
    conn.execute(
        "INSERT INTO conversations (title, topic_id) VALUES (?1, ?2)",
        params![title, topic_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at, topic_id FROM conversations ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ConversationMeta {
            id: r.get(0)?,
            title: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
            topic_id: r.get(4)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---- Tópicos (agrupar conversas) ----

pub fn list_topics(conn: &Connection) -> Result<Vec<Topic>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, brief, notes, folder_path, permission_mode FROM topics ORDER BY sort_order ASC, name COLLATE NOCASE ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(Topic {
            id: r.get(0)?,
            name: r.get(1)?,
            brief: r.get(2)?,
            notes: r.get(3)?,
            folder_path: r.get(4)?,
            permission_mode: r.get(5)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Cria um tópico. Se já existir um com o mesmo nome (case-insensitive), devolve o id existente.
pub fn create_topic(conn: &Connection, name: &str) -> Result<i64> {
    let name = name.trim();
    if let Some(id) = conn
        .query_row(
            "SELECT id FROM topics WHERE name = ?1 COLLATE NOCASE",
            params![name],
            |r| r.get::<_, i64>(0),
        )
        .ok()
    {
        return Ok(id);
    }
    conn.execute("INSERT INTO topics (name) VALUES (?1)", params![name])?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_topic(conn: &Connection, id: i64, name: &str) -> Result<()> {
    conn.execute(
        "UPDATE topics SET name = ?2, updated_at = datetime('now') WHERE id = ?1",
        params![id, name.trim()],
    )?;
    Ok(())
}

pub fn update_topic(
    conn: &Connection,
    id: i64,
    brief: &str,
    notes: &str,
    folder_path: &str,
    permission_mode: &str,
) -> Result<()> {
    conn.execute(
        "UPDATE topics SET brief = ?2, notes = ?3, folder_path = ?4, permission_mode = ?5, updated_at = datetime('now') WHERE id = ?1",
        params![id, brief, notes, folder_path, permission_mode],
    )?;
    Ok(())
}

/// Apaga um tópico — desagrupa os seus chats (topic_id = NULL), não os apaga.
pub fn delete_topic(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET topic_id = NULL WHERE topic_id = ?1",
        params![id],
    )?;
    conn.execute("DELETE FROM topics WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_conversation_topic(conn: &Connection, conv_id: i64, topic_id: Option<i64>) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET topic_id = ?2 WHERE id = ?1",
        params![conv_id, topic_id],
    )?;
    Ok(())
}

/// Tópico de uma conversa (para injetar o brief no contexto — Fase 2).
pub fn get_topic_for_conversation(conn: &Connection, conv_id: i64) -> Option<Topic> {
    conn.query_row(
        "SELECT t.id, t.name, t.brief, t.notes, t.folder_path, t.permission_mode FROM topics t
         JOIN conversations c ON c.topic_id = t.id WHERE c.id = ?1",
        params![conv_id],
        |r| {
            Ok(Topic {
                id: r.get(0)?,
                name: r.get(1)?,
                brief: r.get(2)?,
                notes: r.get(3)?,
                folder_path: r.get(4)?,
                permission_mode: r.get(5)?,
            })
        },
    )
    .ok()
}

pub fn get_messages(conn: &Connection, conversation_id: i64) -> Result<Vec<StoredMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, attachments_json, route, model, input_tokens, output_tokens, cost_usd, tokens_saved, gen_ms, steps_json
         FROM messages WHERE conversation_id = ?1 ORDER BY id ASC",
    )?;
    let rows = stmt.query_map(params![conversation_id], |r| {
        Ok(StoredMessage {
            id: r.get(0)?,
            role: r.get(1)?,
            content: r.get(2)?,
            attachments_json: r.get(3)?,
            route: r.get(4)?,
            model: r.get(5)?,
            input_tokens: r.get(6)?,
            output_tokens: r.get(7)?,
            cost_usd: r.get(8)?,
            tokens_saved: r.get(9)?,
            gen_ms: r.get(10)?,
            steps_json: r.get(11)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Insere uma mensagem e atualiza o `updated_at` da conversa.
#[allow(clippy::too_many_arguments)]
pub fn append_message(
    conn: &Connection,
    conversation_id: i64,
    role: &str,
    content: &str,
    attachments_json: &str,
    route: &str,
    model: &str,
    input_tokens: i64,
    output_tokens: i64,
    cost_usd: f64,
    tokens_saved: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO messages
           (conversation_id, role, content, attachments_json, route, model, input_tokens, output_tokens, cost_usd, tokens_saved)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            conversation_id, role, content, attachments_json, route, model,
            input_tokens, output_tokens, cost_usd, tokens_saved
        ],
    )?;
    let message_id = conn.last_insert_rowid();
    // Índice de pesquisa.
    conn.execute(
        "INSERT INTO messages_fts(content, conversation_id, message_id) VALUES (?1, ?2, ?3)",
        params![content, conversation_id, message_id],
    )
    .ok();
    conn.execute(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(message_id)
}

/// Regista o tempo de geração (ms) de uma mensagem já inserida.
pub fn set_message_gen_ms(conn: &Connection, message_id: i64, gen_ms: i64) -> Result<()> {
    conn.execute(
        "UPDATE messages SET gen_ms = ?1 WHERE id = ?2",
        params![gen_ms, message_id],
    )?;
    Ok(())
}

/// Guarda os breadcrumbs de ferramentas (JSON `["…"]`) de uma mensagem já inserida.
pub fn set_message_steps(conn: &Connection, message_id: i64, steps_json: &str) -> Result<()> {
    conn.execute(
        "UPDATE messages SET steps_json = ?1 WHERE id = ?2",
        params![steps_json, message_id],
    )?;
    Ok(())
}

/// Mantém as primeiras `keep` mensagens da conversa e apaga as restantes
/// (usado ao editar uma mensagem do utilizador: trunca a partir dela).
pub fn truncate_conversation(conn: &Connection, conversation_id: i64, keep: i64) -> Result<()> {
    let mut stmt = conn.prepare(
        "SELECT id FROM messages WHERE conversation_id = ?1 ORDER BY id ASC LIMIT -1 OFFSET ?2",
    )?;
    let ids: Vec<i64> = stmt
        .query_map(params![conversation_id, keep], |r| r.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    for id in ids {
        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM messages_fts WHERE message_id = ?1", params![id])
            .ok();
    }
    conn.execute(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )
    .ok();
    Ok(())
}

/// Lê (resumo, fronteira) da compactação de uma conversa.
pub fn get_compaction(conn: &Connection, conversation_id: i64) -> Result<(String, i64)> {
    let row = conn.query_row(
        "SELECT compacted_summary, compacted_upto FROM conversations WHERE id = ?1",
        params![conversation_id],
        |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)),
    )?;
    Ok(row)
}

/// Guarda o resumo + a fronteira (id da última mensagem compactada) de uma conversa.
pub fn set_compaction(
    conn: &Connection,
    conversation_id: i64,
    summary: &str,
    upto: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET compacted_summary = ?2, compacted_upto = ?3, updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id, summary, upto],
    )?;
    Ok(())
}

/// Apaga todas as mensagens de uma conversa e limpa a compactação (mantém a Saga).
pub fn clear_conversation(conn: &Connection, conversation_id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
    )?;
    conn.execute(
        "DELETE FROM messages_fts WHERE conversation_id = ?1",
        params![conversation_id],
    )
    .ok();
    conn.execute(
        "UPDATE conversations SET compacted_summary = '', compacted_upto = 0, updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(())
}

/// Apaga a última mensagem do assistente de uma conversa (usado ao regenerar).
pub fn delete_last_assistant(conn: &Connection, conversation_id: i64) -> Result<()> {
    let last_id: Option<i64> = conn
        .query_row(
            "SELECT id FROM messages
             WHERE conversation_id = ?1 AND role = 'assistant'
             ORDER BY id DESC LIMIT 1",
            params![conversation_id],
            |r| r.get(0),
        )
        .ok();
    if let Some(id) = last_id {
        conn.execute("DELETE FROM messages WHERE id = ?1", params![id])?;
        conn.execute("DELETE FROM messages_fts WHERE message_id = ?1", params![id])
            .ok();
    }
    Ok(())
}

/// Soma os tokens/custo das mensagens de uma conversa para o painel.
pub fn conversation_accounting(conn: &Connection, conversation_id: i64) -> Result<Accounting> {
    let row = conn.query_row(
        "SELECT
            COALESCE(SUM(CASE WHEN role='assistant' AND route='local'  THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN role='assistant' AND route='claude' THEN 1 ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN route='claude' THEN input_tokens  ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN route='claude' THEN output_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN route='local'  THEN input_tokens + output_tokens ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN route='claude' THEN tokens_saved  ELSE 0 END), 0),
            COALESCE(SUM(CASE WHEN route='claude' THEN cost_usd      ELSE 0 END), 0.0)
         FROM messages WHERE conversation_id = ?1",
        params![conversation_id],
        |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, i64>(4)?,
                r.get::<_, i64>(5)?,
                r.get::<_, f64>(6)?,
            ))
        },
    )?;
    Ok(Accounting {
        local_requests: row.0 as u64,
        claude_requests: row.1 as u64,
        claude_input_tokens: row.2 as u64,
        claude_output_tokens: row.3 as u64,
        tokens_served_local: row.4 as u64,
        tokens_saved_compression: row.5 as u64,
        claude_cost_usd: row.6,
    })
}

// ---- Log de ações (tool-calling) ----

#[derive(Serialize)]
pub struct ActionLogEntry {
    pub id: i64,
    pub conversation_id: i64,
    pub tool: String,
    pub params_json: String,
    pub status: String,
    pub detail: String,
    pub error: String,
    pub created_at: String,
}

/// Insere uma linha no log de ações (hora em UTC) e devolve o id.
pub fn insert_action(
    conn: &Connection,
    conversation_id: i64,
    tool: &str,
    params_json: &str,
    status: &str,
    detail: &str,
    error: &str,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO action_log (conversation_id, tool, params_json, status, detail, error)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![conversation_id, tool, params_json, status, detail, error],
    )?;
    Ok(conn.last_insert_rowid())
}

/// Atualiza o estado/detalhe de uma ação já registada (ex.: EM_EXECUCAO → OK).
pub fn update_action(conn: &Connection, id: i64, status: &str, detail: &str, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE action_log SET status = ?2, detail = ?3, error = ?4 WHERE id = ?1",
        params![id, status, detail, error],
    )?;
    Ok(())
}

/// Devolve o log de ações de uma conversa (mais recentes primeiro).
pub fn get_action_log(conn: &Connection, conversation_id: i64) -> Result<Vec<ActionLogEntry>> {
    let mut stmt = conn.prepare(
        "SELECT id, conversation_id, tool, params_json, status, detail, error, created_at
         FROM action_log WHERE conversation_id = ?1 ORDER BY id DESC LIMIT 200",
    )?;
    let rows = stmt.query_map(params![conversation_id], |r| {
        Ok(ActionLogEntry {
            id: r.get(0)?,
            conversation_id: r.get(1)?,
            tool: r.get(2)?,
            params_json: r.get(3)?,
            status: r.get(4)?,
            detail: r.get(5)?,
            error: r.get(6)?,
            created_at: r.get(7)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ---- Agendamentos (automações) ----

#[derive(Serialize, Clone)]
pub struct Schedule {
    pub id: i64,
    pub name: String,
    pub workflow_name: String,
    pub arguments: String,
    pub cron: String,
    pub enabled: bool,
    pub last_run_at: String,
    pub next_run_epoch: i64,
    /// Resultado da última execução: "OK" | "ERRO" | "SALTADO" | "" (nunca correu).
    pub last_status: String,
    /// Mensagem/erro da última execução (resumo), para mostrar na vista de Automações.
    pub last_error: String,
}

fn row_to_schedule(r: &rusqlite::Row) -> rusqlite::Result<Schedule> {
    Ok(Schedule {
        id: r.get(0)?,
        name: r.get(1)?,
        workflow_name: r.get(2)?,
        arguments: r.get(3)?,
        cron: r.get(4)?,
        enabled: r.get::<_, i64>(5)? != 0,
        last_run_at: r.get(6)?,
        next_run_epoch: r.get(7)?,
        last_status: r.get(8)?,
        last_error: r.get(9)?,
    })
}

const SCHED_COLS: &str =
    "id, name, workflow_name, arguments, cron, enabled, last_run_at, next_run_epoch, last_status, last_error";

#[allow(clippy::too_many_arguments)]
pub fn create_schedule(
    conn: &Connection,
    name: &str,
    workflow_name: &str,
    arguments: &str,
    cron: &str,
    enabled: bool,
    next_run_epoch: i64,
) -> Result<i64> {
    conn.execute(
        "INSERT INTO schedules (name, workflow_name, arguments, cron, enabled, next_run_epoch)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![name, workflow_name, arguments, cron, enabled as i64, next_run_epoch],
    )?;
    Ok(conn.last_insert_rowid())
}

#[allow(clippy::too_many_arguments)]
pub fn update_schedule(
    conn: &Connection,
    id: i64,
    name: &str,
    workflow_name: &str,
    arguments: &str,
    cron: &str,
    enabled: bool,
    next_run_epoch: i64,
) -> Result<()> {
    conn.execute(
        "UPDATE schedules SET name=?2, workflow_name=?3, arguments=?4, cron=?5, enabled=?6, next_run_epoch=?7 WHERE id=?1",
        params![id, name, workflow_name, arguments, cron, enabled as i64, next_run_epoch],
    )?;
    Ok(())
}

pub fn delete_schedule(conn: &Connection, id: i64) -> Result<()> {
    conn.execute("DELETE FROM schedules WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn list_schedules(conn: &Connection) -> Result<Vec<Schedule>> {
    let sql = format!("SELECT {SCHED_COLS} FROM schedules ORDER BY id ASC");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], row_to_schedule)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_schedule(conn: &Connection, id: i64) -> Result<Option<Schedule>> {
    let sql = format!("SELECT {SCHED_COLS} FROM schedules WHERE id = ?1");
    Ok(conn.query_row(&sql, params![id], row_to_schedule).ok())
}

/// Agendamentos ativos e vencidos (next_run_epoch entre 1 e agora).
pub fn due_schedules(conn: &Connection, now_epoch: i64) -> Result<Vec<Schedule>> {
    let sql = format!(
        "SELECT {SCHED_COLS} FROM schedules
         WHERE enabled = 1 AND next_run_epoch > 0 AND next_run_epoch <= ?1"
    );
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![now_epoch], row_to_schedule)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Regista o resultado da última execução (estado + mensagem/erro) de um agendamento.
pub fn set_schedule_result(conn: &Connection, id: i64, status: &str, error: &str) -> Result<()> {
    conn.execute(
        "UPDATE schedules SET last_status=?2, last_error=?3 WHERE id=?1",
        params![id, status, error],
    )?;
    Ok(())
}

pub fn set_schedule_run(conn: &Connection, id: i64, last_run_at: &str, next_run_epoch: i64) -> Result<()> {
    conn.execute(
        "UPDATE schedules SET last_run_at=?2, next_run_epoch=?3 WHERE id=?1",
        params![id, last_run_at, next_run_epoch],
    )?;
    Ok(())
}

/// Encontra (ou cria) uma conversa pelo título — usada pela Saga "Automações".
pub fn find_or_create_conversation(conn: &Connection, title: &str) -> Result<i64> {
    if let Ok(id) = conn.query_row(
        "SELECT id FROM conversations WHERE title = ?1 ORDER BY id ASC LIMIT 1",
        params![title],
        |r| r.get::<_, i64>(0),
    ) {
        return Ok(id);
    }
    create_conversation(conn, title, None)
}

pub fn rename_conversation(conn: &Connection, id: i64, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: i64) -> Result<()> {
    conn.execute(
        "DELETE FROM messages_fts WHERE conversation_id = ?1",
        params![id],
    )
    .ok();
    conn.execute("DELETE FROM messages WHERE conversation_id = ?1", params![id])?;
    conn.execute("DELETE FROM conversations WHERE id = ?1", params![id])?;
    Ok(())
}

/// Define o título só se ainda for o título por omissão (auto-título da 1.ª mensagem).
pub fn maybe_autotitle(conn: &Connection, id: i64, from_prompt: &str) -> Result<()> {
    let title: String = conn
        .query_row(
            "SELECT title FROM conversations WHERE id = ?1",
            params![id],
            |r| r.get(0),
        )
        .unwrap_or_default();
    if title.is_empty() || title == "Nova conversa" {
        let trimmed: String = from_prompt.chars().take(48).collect();
        let trimmed = trimmed.trim();
        if !trimmed.is_empty() {
            rename_conversation(conn, id, trimmed)?;
        }
    }
    Ok(())
}

// ---- Uso de pesquisa web (contador mensal por motor) ----

/// Incrementa o contador de pesquisas do mês (`ym` = "YYYY-MM") para um motor.
pub fn add_search_usage(conn: &Connection, ym: &str, provider: &str, n: u32) -> Result<()> {
    conn.execute(
        "INSERT INTO search_usage (ym, provider, n) VALUES (?1, ?2, ?3)
         ON CONFLICT(ym, provider) DO UPDATE SET n = n + ?3",
        params![ym, provider, n],
    )?;
    Ok(())
}

#[derive(Serialize)]
pub struct SearchUsage {
    pub provider: String,
    pub count: u32,
}

/// Contagens de pesquisa de um mês (`ym` = "YYYY-MM"), por motor.
pub fn search_usage(conn: &Connection, ym: &str) -> Result<Vec<SearchUsage>> {
    let mut stmt =
        conn.prepare("SELECT provider, n FROM search_usage WHERE ym = ?1 ORDER BY n DESC")?;
    let rows = stmt.query_map(params![ym], |r| {
        Ok(SearchUsage {
            provider: r.get(0)?,
            count: r.get::<_, i64>(1)? as u32,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}
