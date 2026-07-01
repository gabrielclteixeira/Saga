//! Ferramentas de ficheiro de um Projeto (= um Tópico com uma pasta anexada).
//! Tudo é resolvido DENTRO da pasta do projeto (sandbox): `resolve_in_root` canonicaliza e
//! exige que o caminho final fique sob a raiz — rejeita `..` e caminhos absolutos que escapem.

use std::path::{Path, PathBuf};

/// Pastas pesadas/ruidosas que não entram na árvore (mostradas colapsadas).
const PRUNE: &[&str] = &[
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    "target",
    "dist",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    "vendor",
    ".gradle",
    ".idea",
];

const MAX_READ_BYTES: usize = 200_000;

/// Resolve `rel` dentro de `root`, garantindo que não escapa da pasta (sandbox).
/// Devolve o caminho absoluto se for seguro; `None` caso contrário.
pub fn resolve_in_root(root: &str, rel: &str) -> Option<PathBuf> {
    let root = Path::new(root);
    let root_canon = root.canonicalize().ok()?;
    // Rejeita caminhos absolutos vindos do modelo; trata `rel` sempre como relativo à raiz.
    let rel_path = Path::new(rel.trim());
    if rel_path.is_absolute() {
        return None;
    }
    let joined = root_canon.join(rel_path);
    // Para um ficheiro a criar (ainda não existe), canonicaliza o pai e reanexa o nome.
    let candidate = match joined.canonicalize() {
        Ok(c) => c,
        Err(_) => {
            let parent = joined.parent()?;
            let file = joined.file_name()?;
            parent.canonicalize().ok()?.join(file)
        }
    };
    if candidate.starts_with(&root_canon) {
        Some(candidate)
    } else {
        None
    }
}

/// Árvore textual podada da pasta (até `max` entradas; profundidade limitada). Para o contexto.
pub fn tree_text(root: &str, max: usize) -> String {
    let base = Path::new(root);
    if !base.is_dir() {
        return String::new();
    }
    let mut out = String::new();
    let mut count = 0usize;
    walk(base, "", &mut out, &mut count, max, 0);
    if count >= max {
        out.push_str("… (árvore truncada)\n");
    }
    out
}

fn walk(dir: &Path, prefix: &str, out: &mut String, count: &mut usize, max: usize, depth: usize) {
    if depth > 6 || *count >= max {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    // Pastas primeiro, depois alfabético.
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for e in entries {
        if *count >= max {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir && PRUNE.contains(&name.as_str()) {
            out.push_str(&format!("{prefix}{name}/ …\n"));
            *count += 1;
            continue;
        }
        out.push_str(&format!("{prefix}{name}{}\n", if is_dir { "/" } else { "" }));
        *count += 1;
        if is_dir {
            walk(&e.path(), &format!("{prefix}  "), out, count, max, depth + 1);
        }
    }
}

/// Lê um ficheiro de texto dentro da pasta (com limite). Binários extraem-se via `extract`.
pub fn read_file(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve_in_root(root, rel).ok_or_else(|| {
        format!("caminho fora da pasta do projeto ou inválido: {rel}")
    })?;
    let bytes = std::fs::read(&path).map_err(|e| format!("não foi possível ler {rel}: {e}"))?;
    // Texto direto; se não for UTF-8 válido, tenta extrair (pdf/docx/xlsx) pelo nome.
    if let Ok(s) = std::str::from_utf8(&bytes) {
        let mut s = s.to_string();
        if s.len() > MAX_READ_BYTES {
            s.truncate(MAX_READ_BYTES);
            s.push_str("\n… (truncado)");
        }
        Ok(s)
    } else {
        Ok(crate::extract::extract(rel, &bytes))
    }
}

/// Já existe um ficheiro neste caminho? (Para distinguir `project_create` de `project_edit`.)
pub fn file_exists(root: &str, rel: &str) -> bool {
    resolve_in_root(root, rel).map(|p| p.is_file()).unwrap_or(false)
}

/// Escreve/cria um ficheiro de texto dentro da pasta (cria pastas-pai). Ação confirmada pelo gate.
pub fn write_file(root: &str, rel: &str, content: &str) -> Result<(), String> {
    let path = resolve_in_root(root, rel).ok_or_else(|| {
        format!("caminho fora da pasta do projeto ou inválido: {rel}")
    })?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("não foi possível criar a pasta: {e}"))?;
    }
    std::fs::write(&path, content).map_err(|e| format!("não foi possível gravar {rel}: {e}"))?;
    Ok(())
}

/// Apaga um ficheiro dentro da pasta (não apaga pastas). Ação confirmada pelo gate.
pub fn delete_file(root: &str, rel: &str) -> Result<(), String> {
    let path = resolve_in_root(root, rel).ok_or_else(|| {
        format!("caminho fora da pasta do projeto ou inválido: {rel}")
    })?;
    if path.is_dir() {
        return Err(format!("{rel} é uma pasta — só apago ficheiros"));
    }
    std::fs::remove_file(&path).map_err(|e| format!("não foi possível apagar {rel}: {e}"))?;
    Ok(())
}
