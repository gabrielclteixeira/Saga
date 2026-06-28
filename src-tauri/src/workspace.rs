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
    /// Item ligado/desligado (frontmatter `enabled:`; default true quando ausente).
    pub enabled: bool,
}

#[derive(Serialize, Default, Clone)]
pub struct WorkspaceIndex {
    pub skills: Vec<DocMeta>,
    pub playbooks: Vec<DocMeta>,
    pub workflows: Vec<DocMeta>,
    pub agents: Vec<DocMeta>,
}

impl WorkspaceIndex {
    /// Só os itens ativos (para os consumidores: Dispatcher, manifesto, etc.). A UI usa o índice
    /// completo (mostra os desativados a cinzento).
    pub fn active(&self) -> WorkspaceIndex {
        let keep = |v: &[DocMeta]| v.iter().filter(|d| d.enabled).cloned().collect();
        WorkspaceIndex {
            skills: keep(&self.skills),
            playbooks: keep(&self.playbooks),
            workflows: keep(&self.workflows),
            agents: keep(&self.agents),
        }
    }
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

/// Lê a flag `enabled:` do frontmatter. Default `true` (ausente = ativo); só `false` se for
/// explicitamente false/0/no/não.
pub fn parse_enabled(content: &str) -> bool {
    let trimmed = content.trim_start();
    if let Some(rest) = trimmed.strip_prefix("---") {
        if let Some(end) = rest.find("\n---") {
            for line in rest[..end].lines() {
                if let Some(v) = line.strip_prefix("enabled:") {
                    let v = clean_value(v).to_lowercase();
                    return !matches!(v.as_str(), "false" | "0" | "no" | "não" | "nao");
                }
            }
        }
    }
    true
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

/// Extrai os triggers de uma descrição de skill (ex.: "... Triggers: pdf, criar pdf, exportar pdf").
/// Devolve cada termo em minúsculas, sem espaços nas pontas, sem vazios.
pub fn parse_triggers(description: &str) -> Vec<String> {
    let lower = description.to_lowercase();
    let Some(pos) = lower.find("triggers:") else {
        return Vec::new();
    };
    description[pos + "triggers:".len()..]
        .split(',')
        .map(|t| t.trim().to_lowercase())
        .filter(|t| !t.is_empty())
        .collect()
}

/// Skills cujos triggers batem no texto do utilizador → (nome, corpo das instruções).
/// Determinístico (sem modelo): suporte às skills na rota local. Limita a 2 skills e trunca
/// o corpo (~6 KB) para conter os tokens injetados no system prompt.
pub fn triggered_skills(root: &str, text: &str) -> Vec<(String, String)> {
    const MAX_SKILLS: usize = 2;
    const MAX_BODY: usize = 6000;
    let hay = text.to_lowercase();
    let mut out: Vec<(String, String)> = Vec::new();
    let Ok(entries) = fs::read_dir(skills_dir(root)) else {
        return out;
    };
    for e in entries.flatten() {
        if out.len() >= MAX_SKILLS {
            break;
        }
        if !e.path().is_dir() {
            continue;
        }
        let Ok(content) = fs::read_to_string(e.path().join("SKILL.md")) else {
            continue;
        };
        if !parse_enabled(&content) {
            continue;
        }
        let dir_name = e.file_name().to_string_lossy().to_string();
        let (n, d) = parse_frontmatter(&content);
        let desc = d.unwrap_or_default();
        let triggers = parse_triggers(&desc);
        if triggers.iter().any(|t| hay.contains(t.as_str())) {
            let mut body = strip_frontmatter(&content);
            if body.len() > MAX_BODY {
                body.truncate(MAX_BODY);
                body.push_str("\n…");
            }
            out.push((n.unwrap_or(dir_name), body));
        }
    }
    out
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
                    enabled: parse_enabled(&content),
                });
            }
        }
    }

    if let Ok(entries) = fs::read_dir(playbooks_dir(root)) {
        for e in entries.flatten() {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("md") {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|x| x.to_str()).map(str::to_string) else {
                continue;
            };
            // Playbooks normalmente não têm frontmatter; só lemos a flag `enabled` (e name/desc se existirem).
            let content = fs::read_to_string(&p).unwrap_or_default();
            let (n, d) = parse_frontmatter(&content);
            idx.playbooks.push(DocMeta {
                name: n.unwrap_or(stem),
                description: d.unwrap_or_default(),
                enabled: parse_enabled(&content),
            });
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
                    enabled: parse_enabled(&content),
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
                    enabled: parse_enabled(&content),
                });
            }
        }
    }

    idx.skills.sort_by(|a, b| a.name.cmp(&b.name));
    idx.playbooks.sort_by(|a, b| a.name.cmp(&b.name));
    idx.workflows.sort_by(|a, b| a.name.cmp(&b.name));
    idx.agents.sort_by(|a, b| a.name.cmp(&b.name));
    idx
}

/// Corpo de uma skill (sem frontmatter), por nome de pasta.
pub fn read_skill(root: &str, name: &str) -> Option<String> {
    let p = skills_dir(root).join(sanitize(name)).join("SKILL.md");
    fs::read_to_string(p).ok().map(|c| strip_frontmatter(&c))
}

/// Conteúdo de um playbook, por nome (sem extensão). Remove o frontmatter (se existir) para que a
/// flag `enabled:` não vaze para o texto injetado; playbooks sem frontmatter ficam intactos.
pub fn read_playbook(root: &str, name: &str) -> Option<String> {
    let p = playbooks_dir(root).join(format!("{}.md", sanitize(name)));
    fs::read_to_string(p).ok().map(|c| strip_frontmatter(&c))
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

/// Documento ativo? (frontmatter `enabled:`; ausente = ativo; ficheiro inexistente = ativo).
pub fn is_enabled(root: &str, kind: &str, name: &str) -> bool {
    read_doc(root, kind, name)
        .map(|c| parse_enabled(&c))
        .unwrap_or(true)
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

// ---- Variantes em inglês (seleção por idioma da UI) ----

const PDF_SKILL_EN: &str = r#"---
name: pdf
description: "Create a PDF from a document or report. Triggers: pdf, create pdf, export pdf, generate report, make a document"
---

# Create PDF

When the user asks for a PDF, report or document:

1. Write a well-structured, complete document on the requested topic (headings, sections,
   lists and tables where they help). Be clear and direct.
2. **If the `create_pdf` tool is available** (API mode with browser tools), call it with
   `title` (the document title) and `html` (the body as simple HTML: `<h1>`, `<h2>`, `<p>`,
   `<ul>`, `<ol>`, `<table>`, `<pre>`, `<strong>`…). It writes the file and returns the path.
3. **Otherwise**, return the document as a markdown (```markdown) or HTML (```html) code block —
   it opens as an artifact — and tell the user to click **PDF** in the artifact panel to save it.

Don't make up data; if information is missing, ask the user or clearly flag the gaps.
"#;

const AGENT_ENGINEER_EN: &str = r#"---
name: Software Engineer
description: "Experienced developer: writes, reviews and explains code with rigor."
tools: true
subagents: false
research: false
route: local
---

You are a senior software engineer. You write correct, readable and idiomatic code, following
the conventions of the language and the project at hand. Before proposing a solution, you think
about edge cases and failure modes. When you show code, keep it minimal and focused; explain the
important decisions in a few lines. When you're unsure about an API or version, say so instead of
inventing it. You prefer clarity over cleverness.
"#;

const AGENT_RESEARCHER_EN: &str = r#"---
name: Web Researcher
description: "Searches online, cross-checks sources and answers with references."
tools: true
research: true
subagents: false
route: local
---

You are an expert web researcher. For any factual or current question, you **search online**
before answering, cross-check several sources and distrust unsupported claims. Your answer
clearly separates what is confirmed from what is uncertain. You always end with a list of the
sources (titles + URLs) you used. If sources contradict each other, you say so. Never invent
a reference.
"#;

const AGENT_WRITER_EN: &str = r#"---
name: Writer
description: "Writes and improves text: clear, direct and in the right tone."
tools: false
research: false
subagents: false
route: local
---

You are a professional writer. You write clearly, directly and appropriately for the audience and
goal. You use active voice, sentences with rhythm, and cut whatever doesn't add value. You adapt
the tone to the request (formal, friendly, technical). When you rewrite, you preserve the meaning
and improve readability. If the request is ambiguous, you ask one short question before writing.
"#;

/// Um documento embutido com variantes PT/EN (o ficheiro de agente usa o nome como identidade).
struct Seed {
    name_pt: &'static str,
    name_en: &'static str,
    body_pt: &'static str,
    body_en: &'static str,
    /// slug da 1.ª versão (só agentes), para migrar ficheiros antigos.
    legacy_slug: &'static str,
}

const AGENT_SEEDS: &[Seed] = &[
    Seed {
        name_pt: "Engenheiro de Software",
        name_en: "Software Engineer",
        body_pt: AGENT_ENGINEER,
        body_en: AGENT_ENGINEER_EN,
        legacy_slug: "engenheiro-de-software",
    },
    Seed {
        name_pt: "Investigador Web",
        name_en: "Web Researcher",
        body_pt: AGENT_RESEARCHER,
        body_en: AGENT_RESEARCHER_EN,
        legacy_slug: "investigador-web",
    },
    Seed {
        name_pt: "Redator",
        name_en: "Writer",
        body_pt: AGENT_WRITER,
        body_en: AGENT_WRITER_EN,
        legacy_slug: "redator",
    },
];

/// Escreve as skills/agentes embutidos no idioma da UI (`lang` = "pt"|"en"). Não sobrescreve
/// edições do utilizador: um default só é (re)traduzido se o ficheiro em disco for ainda um
/// default não modificado (de qualquer idioma).
pub fn seed_defaults(root: &str, lang: &str) {
    if root.trim().is_empty() {
        return;
    }
    let en = lang.eq_ignore_ascii_case("en");

    // Skill PDF — nome de ficheiro estável ("pdf"); só o conteúdo muda com o idioma.
    let pdf_want = if en { PDF_SKILL_EN } else { PDF_SKILL };
    let pdf_path = skills_dir(root).join("pdf").join("SKILL.md");
    match fs::read_to_string(&pdf_path) {
        Err(_) => {
            let _ = write_doc(root, "skill", "pdf", pdf_want);
        }
        Ok(cur) => {
            // Re-traduz só se for um default não modificado.
            if (cur == PDF_SKILL || cur == PDF_SKILL_EN) && cur != pdf_want {
                let _ = write_doc(root, "skill", "pdf", pdf_want);
            }
        }
    }

    // Agentes — identidade = nome de exibição (ficheiro = sanitize(nome).md).
    for s in AGENT_SEEDS {
        let (want_name, want_body) = if en {
            (s.name_en, s.body_en)
        } else {
            (s.name_pt, s.body_pt)
        };
        let Some(want_path) = doc_path(root, "agent", want_name) else {
            continue;
        };
        // Migra o ficheiro da 1.ª versão (nome-slug) para o nome canónico PT, preservando
        // edições — depois a normalização por idioma trata do resto.
        let legacy_path = agents_dir(root).join(format!("{}.md", s.legacy_slug));
        if let Some(pt_path) = doc_path(root, "agent", s.name_pt) {
            if legacy_path.exists() && legacy_path != pt_path && !pt_path.exists() {
                let _ = fs::rename(&legacy_path, &pt_path);
            }
        }
        let known = [s.body_pt, s.body_en];
        // Ficheiros candidatos: variante PT, variante EN e o slug da 1.ª versão.
        let candidates = [
            doc_path(root, "agent", s.name_pt),
            doc_path(root, "agent", s.name_en),
            Some(agents_dir(root).join(format!("{}.md", s.legacy_slug))),
        ];
        let mut edited = false;
        let mut defaults_on_disk: Vec<std::path::PathBuf> = Vec::new();
        for c in candidates.into_iter().flatten() {
            if !c.exists() {
                continue;
            }
            match fs::read_to_string(&c) {
                Ok(content) if known.contains(&content.as_str()) => {
                    if !defaults_on_disk.contains(&c) {
                        defaults_on_disk.push(c);
                    }
                }
                Ok(_) => edited = true, // o utilizador editou — não mexer
                Err(_) => {}
            }
        }
        if edited {
            continue;
        }
        // Normaliza para o idioma atual: remove defaults de outro idioma, garante o pretendido.
        for p in &defaults_on_disk {
            if p != &want_path {
                let _ = fs::remove_file(p);
            }
        }
        if !want_path.exists() {
            let _ = write_doc(root, "agent", want_name, want_body);
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
