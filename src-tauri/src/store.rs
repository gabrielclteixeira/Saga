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
        "#,
    )?;
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

pub fn create_conversation(conn: &Connection, title: &str) -> Result<i64> {
    conn.execute(
        "INSERT INTO conversations (title) VALUES (?1)",
        params![title],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn list_conversations(conn: &Connection) -> Result<Vec<ConversationMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, created_at, updated_at FROM conversations ORDER BY updated_at DESC, id DESC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ConversationMeta {
            id: r.get(0)?,
            title: r.get(1)?,
            created_at: r.get(2)?,
            updated_at: r.get(3)?,
        })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

pub fn get_messages(conn: &Connection, conversation_id: i64) -> Result<Vec<StoredMessage>> {
    let mut stmt = conn.prepare(
        "SELECT id, role, content, attachments_json, route, model, input_tokens, output_tokens, cost_usd, tokens_saved
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
