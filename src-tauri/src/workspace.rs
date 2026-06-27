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
    pub agents: Vec<DocMeta>,
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
fn agents_dir(root: &str) -> PathBuf {
    Path::new(root).join("agents")
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

    if let Ok(entries) = fs::read_dir(agents_dir(root)) {
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
                idx.agents.push(DocMeta {
                    name: n.unwrap_or(stem),
                    description: d.unwrap_or_default(),
                });
            }
        }
    }

    idx.skills.sort_by(|a, b| a.name.cmp(&b.name));
    idx.playbooks.sort();
    idx.workflows.sort_by(|a, b| a.name.cmp(&b.name));
    idx.agents.sort_by(|a, b| a.name.cmp(&b.name));
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
        "agent" => agents_dir(root).join(format!("{safe}.md")),
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

/// Skill embutida por defeito para criar PDFs.
const PDF_SKILL: &str = r#"---
name: pdf
description: "Cria um PDF a partir de um documento ou relatório. Triggers: pdf, criar pdf, exportar pdf, gerar relatório, fazer um documento"
---

# Criar PDF

Quando o utilizador pedir um PDF, relatório ou documento:

1. Escreve um documento bem estruturado e completo sobre o tema pedido (títulos, secções,
   listas e tabelas quando ajudarem). Sê claro e direto.
2. **Se a ferramenta `create_pdf` estiver disponível** (modo API com ferramentas de browser),
   chama-a com `title` (título do documento) e `html` (o corpo em HTML simples: `<h1>`, `<h2>`,
   `<p>`, `<ul>`, `<ol>`, `<table>`, `<pre>`, `<strong>`…). Ela grava o ficheiro e devolve o caminho.
3. **Caso contrário**, devolve o documento como um bloco de código markdown (```markdown) ou HTML
   (```html) — ele abre como artefacto — e diz ao utilizador para clicar em **PDF** no painel do
   artefacto para guardar como PDF.

Não inventes dados; se faltar informação, pede ao utilizador ou indica claramente as lacunas.
"#;

/// Agentes (personas) embutidos por defeito. Frontmatter: name, description e dicas
/// (tools/research/subagents/route) que a UI aplica como toggles ao escolher o agente.
/// O corpo é o system prompt injetado.
const AGENT_ENGINEER: &str = r#"---
name: Engenheiro de Software
description: "Programador experiente: escreve, revê e explica código com rigor."
tools: true
subagents: false
research: false
route: local
---

És um engenheiro de software sénior. Escreves código correto, legível e idiomático,
seguindo as convenções da linguagem e do projeto em causa. Antes de propor uma solução,
pensas nos casos extremos e nos modos de falha. Quando mostras código, mantém-no mínimo e
focado; explica as decisões importantes em poucas linhas. Quando não tiveres a certeza de
uma API ou versão, di-lo em vez de inventar. Preferes clareza a esperteza.
"#;

const AGENT_RESEARCHER: &str = r#"---
name: Investigador Web
description: "Pesquisa online, cruza fontes e responde com referências."
tools: true
research: true
subagents: false
route: local
---

És um investigador web especialista. Para qualquer pergunta factual ou atual, **pesquisas
online** antes de responder, cruzas várias fontes e desconfias de afirmações sem suporte.
A tua resposta distingue claramente o que está confirmado do que é incerto. Terminas sempre
com uma lista de fontes (títulos + URLs) que usaste. Se as fontes se contradisserem, dizes-o.
Nunca inventes uma referência.
"#;

const AGENT_WRITER: &str = r#"---
name: Redator
description: "Escreve e melhora textos: claros, diretos e no tom certo."
tools: false
research: false
subagents: false
route: local
---

És um redator profissional. Escreves de forma clara, direta e adequada ao público e ao
objetivo. Usas voz ativa, frases com ritmo e cortas o que não acrescenta. Adaptas o tom ao
pedido (formal, próximo, técnico). Quando reescreves, preservas o sentido e melhoras a
legibilidade. Se o pedido for ambíguo, fazes uma pergunta curta antes de escrever.
"#;

/// Escreve as skills/agentes embutidos por defeito que ainda não existam
/// (não sobrescreve edições do utilizador).
pub fn seed_defaults(root: &str) {
    if root.trim().is_empty() {
        return;
    }
    let pdf = skills_dir(root).join("pdf").join("SKILL.md");
    if !pdf.exists() {
        let _ = write_doc(root, "skill", "pdf", PDF_SKILL);
    }
    // O identificador de um agente é o seu NOME DE EXIBIÇÃO; o ficheiro é `sanitize(nome).md`
    // (igual a skills/workflows criados na UI), para que picker/leitura/edição resolvam o mesmo
    // caminho. (nome de exibição, slug da 1.ª versão, corpo)
    for (display, legacy_slug, body) in [
        ("Engenheiro de Software", "engenheiro-de-software", AGENT_ENGINEER),
        ("Investigador Web", "investigador-web", AGENT_RESEARCHER),
        ("Redator", "redator", AGENT_WRITER),
    ] {
        let Some(canonical) = doc_path(root, "agent", display) else {
            continue;
        };
        // Migra ficheiros da 1.ª versão (nome-slug ≠ sanitize(nome)) sem perder edições.
        let legacy = agents_dir(root).join(format!("{legacy_slug}.md"));
        if legacy.exists() && !canonical.exists() {
            let _ = fs::rename(&legacy, &canonical);
        }
        if !canonical.exists() {
            let _ = write_doc(root, "agent", display, body);
        }
    }
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
