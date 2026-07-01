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

/// Lista os ficheiros (não pastas) da pasta do projeto — caminhos relativos, barras normais.
/// Para a UI de pré-visualização (ver commands::list_project_files), não para o contexto do
/// modelo. Ignora as mesmas pastas pesadas que `tree_text`; limitado a `max` entradas.
pub fn list_files(root: &str, max: usize) -> Vec<String> {
    let base = Path::new(root);
    if !base.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    walk_files(base, base, &mut out, max, 0);
    out
}

/// Estado (tamanho, data de modificação) de cada ficheiro da pasta — para detetar o que uma
/// chamada externa (a CLI, com as suas próprias tools) mudou, comparando um "antes" com um
/// "depois". Não sabemos QUE tools a CLI chamou (corre fora do Dispatcher do Saga), mas sabemos
/// o que ficou diferente no disco — suficiente para um rasto no Action Log.
pub fn snapshot(root: &str, max: usize) -> std::collections::HashMap<String, (u64, Option<std::time::SystemTime>)> {
    let mut out = std::collections::HashMap::new();
    for rel in list_files(root, max) {
        if let Ok(meta) = std::fs::metadata(Path::new(root).join(&rel)) {
            out.insert(rel, (meta.len(), meta.modified().ok()));
        }
    }
    out
}

/// Compara dois snapshots e devolve os caminhos que mudaram, com "(novo)"/"(editado)" anexado.
pub fn diff_snapshots(
    before: &std::collections::HashMap<String, (u64, Option<std::time::SystemTime>)>,
    after: &std::collections::HashMap<String, (u64, Option<std::time::SystemTime>)>,
) -> Vec<String> {
    let mut out = Vec::new();
    for (path, stats) in after {
        match before.get(path) {
            None => out.push(format!("{path} (novo)")),
            Some(prev) if prev != stats => out.push(format!("{path} (editado)")),
            _ => {}
        }
    }
    out.sort();
    out
}

fn walk_files(base: &Path, dir: &Path, out: &mut Vec<String>, max: usize, depth: usize) {
    if depth > 6 || out.len() >= max {
        return;
    }
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = rd.flatten().collect();
    entries.sort_by_key(|e| {
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        (!is_dir, e.file_name())
    });
    for e in entries {
        if out.len() >= max {
            return;
        }
        let name = e.file_name().to_string_lossy().to_string();
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        if is_dir {
            if !PRUNE.contains(&name.as_str()) {
                walk_files(base, &e.path(), out, max, depth + 1);
            }
            continue;
        }
        if let Ok(rel) = e.path().strip_prefix(base) {
            out.push(rel.to_string_lossy().replace('\\', "/"));
        }
    }
}

/// Limite (bytes) para pré-visualização na UI — mais generoso que o do contexto do modelo, só
/// para não travar a interface com um ficheiro gigante.
const MAX_PREVIEW_BYTES: usize = 5_000_000;

/// Lê o conteúdo bruto de um ficheiro (sem o cabeçalho de tamanho de `read_file`, que é para o
/// modelo) — para a pré-visualização de artefactos na UI.
pub fn read_file_raw(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve_in_root(root, rel).ok_or_else(|| {
        format!("caminho fora da pasta do projeto ou inválido: {rel}")
    })?;
    let bytes = std::fs::read(&path).map_err(|e| format!("não foi possível ler {rel}: {e}"))?;
    if bytes.len() > MAX_PREVIEW_BYTES {
        return Err(format!(
            "{rel} é demasiado grande para pré-visualizar ({:.1} MB)",
            bytes.len() as f64 / 1_000_000.0
        ));
    }
    std::str::from_utf8(&bytes)
        .map(|s| s.to_string())
        .map_err(|_| format!("{rel} não é texto — a pré-visualização só suporta ficheiros de texto"))
}

/// Tamanho legível (B / KB / MB) — para o modelo aferir se o ficheiro cabe no contexto.
fn human_bytes(n: usize) -> String {
    if n < 1024 {
        format!("{n} B")
    } else if n < 1024 * 1024 {
        format!("{:.1} KB", n as f64 / 1024.0)
    } else {
        format!("{:.1} MB", n as f64 / (1024.0 * 1024.0))
    }
}

/// Lê um ficheiro de texto dentro da pasta (com limite). Binários extraem-se via `extract`.
/// Prefixa um cabeçalho com o tamanho (linhas · bytes) para o modelo decidir se cabe no contexto
/// antes de o reescrever com project_edit.
pub fn read_file(root: &str, rel: &str) -> Result<String, String> {
    let path = resolve_in_root(root, rel).ok_or_else(|| {
        format!("caminho fora da pasta do projeto ou inválido: {rel}")
    })?;
    let bytes = std::fs::read(&path).map_err(|e| format!("não foi possível ler {rel}: {e}"))?;
    let size = human_bytes(bytes.len());
    // Texto direto; se não for UTF-8 válido, tenta extrair (pdf/docx/xlsx) pelo nome.
    if let Ok(s) = std::str::from_utf8(&bytes) {
        let lines = s.lines().count();
        let header = format!("[{rel} · {lines} linhas · {size}]\n\n");
        let mut body = s.to_string();
        if body.len() > MAX_READ_BYTES {
            body.truncate(MAX_READ_BYTES);
            body.push_str("\n… (truncado — ficheiro grande; edita só o necessário)");
        }
        Ok(format!("{header}{body}"))
    } else {
        let text = crate::extract::extract(rel, &bytes);
        Ok(format!("[{rel} · {size} · binário/extraído]\n\n{text}"))
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
