//! Leitura de memória: ficheiros markdown numa pasta + um CLAUDE.md opcional.

use std::fs;
use std::path::Path;

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
