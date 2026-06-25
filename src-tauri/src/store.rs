//! Persistência de conversas e mensagens em SQLite (rusqlite, bundled).

use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::Serialize;

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
        "#,
    )?;
    Ok(())
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
    conn.execute(
        "UPDATE conversations SET updated_at = datetime('now') WHERE id = ?1",
        params![conversation_id],
    )?;
    Ok(conn.last_insert_rowid())
}

pub fn rename_conversation(conn: &Connection, id: i64, title: &str) -> Result<()> {
    conn.execute(
        "UPDATE conversations SET title = ?2 WHERE id = ?1",
        params![id, title],
    )?;
    Ok(())
}

pub fn delete_conversation(conn: &Connection, id: i64) -> Result<()> {
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
