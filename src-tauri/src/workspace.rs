//! Workspace de ficheiros do utilizador: skills, playbooks e workflows — markdown
//! editável e versionável, à semelhança do `.claude/` do repo de origem. As skills
//! são carregadas sob demanda pelo modelo (tool `load_skill`); os playbooks por
//! `read_playbook`; os workflows são procedimentos corridos pelo agente (Fase D).

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
pub struct DocMeta {
    pub name: String,
    pub description: String,
}

#[derive(Serialize, Default, Clone)]
pub struct WorkspaceIndex {
    pub skills: Vec<DocMeta>,
    pub playbooks: Vec<String>,
    pub workflows: Vec<DocMeta>,
}

fn skills_dir(root: &str) -> PathBuf {
    Path::new(root).join("skills")
}
fn playbooks_dir(root: &str) -> PathBuf {
    Path::new(root).join("playbooks")
}
fn workflows_dir(root: &str) -> PathBuf {
    Path::new(root).join("workflows")
}

/// Lê (name, description) de um frontmatter YAML simples no topo de um markdown.
pub fn parse_frontmatter(content: &str) -> (Option<String>, Option<String>) {
    let mut name = None;
    let mut desc = None;
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("name:") {
                    name = Some(clean_value(v));
                } else if let Some(v) = line.strip_prefix("description:") {
                    desc = Some(clean_value(v));
                }
            }
        }
    }
    (name, desc)
}

fn clean_value(v: &str) -> String {
    v.trim().trim_matches('"').trim_matches('\'').to_string()
}

/// Devolve o corpo do markdown sem o bloco de frontmatter.
fn strip_frontmatter(content: &str) -> String {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            let after = &rest[end + 4..];
            return after.trim_start_matches(['\n', '\r']).to_string();
        }
    }
    content.to_string()
}

/// Varre o workspace e devolve o índice (nomes + descrições).
pub fn index(root: &str) -> WorkspaceIndex {
    let mut idx = WorkspaceIndex::default();

    if let Ok(entries) = fs::read_dir(skills_dir(root)) {
        for e in entries.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            if let Ok(content) = fs::read_to_string(e.path().join("SKILL.md")) {
                let dir_name = e.file_name().to_string_lossy().to_string();
                let (n, d) = parse_frontmatter(&content);
                idx.skills.push(DocMeta {
                    name: n.unwrap_or(dir_name),
                    description: d.unwrap_or_default(),
                });
            }
        }
    }

    if let Ok(entries) = fs::read_dir(playbooks_dir(root)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) == Some("md") {
                if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
                    idx.playbooks.push(stem.to_string());
                }
            }
        }
    }

    if let Ok(entries) = fs::read_dir(workflows_dir(root)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            if let Ok(content) = fs::read_to_string(&p) {
                let stem = p
                    .file_stem()
                    .and_then(|x| x.to_str())
                    .unwrap_or("")
                    .to_string();
                let (n, d) = parse_frontmatter(&content);
                idx.workflows.push(DocMeta {
                    name: n.unwrap_or(stem),
                    description: d.unwrap_or_default(),
                });
            }
        }
    }

    idx.skills.sort_by(|a, b| a.name.cmp(&b.name));
    idx.playbooks.sort();
    idx.workflows.sort_by(|a, b| a.name.cmp(&b.name));
    idx
}

/// Corpo de uma skill (sem frontmatter), por nome de pasta.
pub fn read_skill(root: &str, name: &str) -> Option<String> {
    let p = skills_dir(root).join(sanitize(name)).join("SKILL.md");
    fs::read_to_string(p).ok().map(|c| strip_frontmatter(&c))
}

/// Conteúdo de um playbook, por nome (sem extensão).
pub fn read_playbook(root: &str, name: &str) -> Option<String> {
    let p = playbooks_dir(root).join(format!("{}.md", sanitize(name)));
    fs::read_to_string(p).ok()
}

/// Corpo de um workflow (sem frontmatter), por nome (sem extensão).
pub fn read_workflow(root: &str, name: &str) -> Option<String> {
    let p = workflows_dir(root).join(format!("{}.md", sanitize(name)));
    fs::read_to_string(p).ok().map(|c| strip_frontmatter(&c))
}

/// Evita travessia de caminhos: mantém só alfanuméricos, hífen e underscore.
fn sanitize(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric() || *c == '-' || *c == '_')
        .collect()
}

// ---- CRUD de ficheiros do workspace (para o editor da UI) ----

/// Caminho do ficheiro de um documento por tipo: "skill" | "playbook" | "workflow".
fn doc_path(root: &str, kind: &str, name: &str) -> Option<PathBuf> {
    let safe = sanitize(name);
    if safe.is_empty() {
        return None;
    }
    Some(match kind {
        "skill" => skills_dir(root).join(&safe).join("SKILL.md"),
        "playbook" => playbooks_dir(root).join(format!("{safe}.md")),
        "workflow" => workflows_dir(root).join(format!("{safe}.md")),
        _ => return None,
    })
}

/// Lê o conteúdo cru (com frontmatter) de um documento, para edição.
pub fn read_doc(root: &str, kind: &str, name: &str) -> Option<String> {
    fs::read_to_string(doc_path(root, kind, name)?).ok()
}

/// Cria/atualiza um documento do workspace.
pub fn write_doc(root: &str, kind: &str, name: &str, content: &str) -> anyhow::Result<()> {
    let path = doc_path(root, kind, name)
        .ok_or_else(|| anyhow::anyhow!("tipo ou nome inválido"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, content)?;
    Ok(())
}

/// Apaga um documento do workspace (e a pasta da skill, se for o caso).
pub fn delete_doc(root: &str, kind: &str, name: &str) -> anyhow::Result<()> {
    let path = doc_path(root, kind, name)
        .ok_or_else(|| anyhow::anyhow!("tipo ou nome inválido"))?;
    if kind == "skill" {
        if let Some(dir) = path.parent() {
            fs::remove_dir_all(dir).ok();
            return Ok(());
        }
    }
    fs::remove_file(path).ok();
    Ok(())
}
