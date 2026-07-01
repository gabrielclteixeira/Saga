//! Leitura e escrita de memória: ficheiros markdown numa pasta + um CLAUDE.md opcional.

use std::fs;
use std::path::{Path, PathBuf};

use crate::settings::Settings;

/// Lê e concatena toda a memória disponível (ficheiros .md da pasta + CLAUDE.md).
/// Devolve string vazia se nada existir.
pub fn load_raw(settings: &Settings) -> String {
    let mut parts: Vec<String> = Vec::new();

    let dir = Path::new(&settings.memory_dir);
    if dir.is_dir() {
        if let Ok(entries) = fs::read_dir(dir) {
            let mut files: Vec<_> = entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| {
                    p.extension()
                        .map(|e| e.eq_ignore_ascii_case("md"))
                        .unwrap_or(false)
                })
                .collect();
            files.sort();
            for path in files {
                if let Ok(content) = fs::read_to_string(&path) {
                    let name = path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    parts.push(format!("# {name}\n{content}"));
                }
            }
        }
    }

    if !settings.claude_md_path.trim().is_empty() {
        if let Ok(content) = fs::read_to_string(&settings.claude_md_path) {
            parts.push(format!("# CLAUDE.md\n{content}"));
        }
    }

    parts.join("\n\n---\n\n")
}

/// Escreve uma nova nota de memória (`<slug>-<data>.md`) na pasta configurada; cria a pasta se
/// não existir. Acrescenta um sufixo numérico se já houver uma nota com o mesmo nome+data.
pub fn write_memory_note(dir: &str, name_hint: &str, content: &str) -> std::io::Result<PathBuf> {
    let dir_path = Path::new(dir);
    fs::create_dir_all(dir_path)?;
    let slug = slugify(name_hint);
    let base = if slug.is_empty() { "nota".to_string() } else { slug };
    let date = chrono::Local::now().format("%Y-%m-%d").to_string();
    let mut path = dir_path.join(format!("{base}-{date}.md"));
    let mut n = 2;
    while path.exists() {
        path = dir_path.join(format!("{base}-{date}-{n}.md"));
        n += 1;
    }
    fs::write(&path, content)?;
    Ok(path)
}

/// Nome de ficheiro seguro e legível a partir de texto livre: minúsculas, hífens, sem acentos
/// tratados (fica alfanumérico simples), sem hífens duplicados/nas pontas.
fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for c in s.trim().to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    out
}

/// Pré-visualização curta para a UI (primeiros N caracteres).
pub fn preview(settings: &Settings, max_chars: usize) -> String {
    let raw = load_raw(settings);
    if raw.chars().count() <= max_chars {
        raw
    } else {
        let truncated: String = raw.chars().take(max_chars).collect();
        format!("{truncated}…")
    }
}
