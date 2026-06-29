//! Resolução de executáveis para apps GUI.
//!
//! No macOS (e por vezes no Linux), uma app lançada pelo Finder/Dock herda um PATH mínimo
//! (`/usr/bin:/bin:/usr/sbin:/sbin`) e não vê o Homebrew, o instalador nativo da Claude
//! (`~/.local/bin`, `~/.claude/local`), o npm global, o bun nem o nvm — por isso `claude`,
//! `node` ou `npx` resolvem no terminal mas falham dentro da app ("Claude CLI não encontrada").
//! Este módulo procura o binário nas localizações habituais (devolve caminho absoluto) e
//! constrói um PATH aumentado para os subprocessos (p.ex. um `claude` instalado via npm
//! precisa de encontrar o `node`).
//!
//! No Windows as apps GUI já herdam o PATH do sistema, por isso aqui é tudo identidade —
//! não mexemos no comportamento que já funciona.

#[cfg(not(windows))]
mod imp {
    use std::path::PathBuf;
    use std::sync::OnceLock;

    /// Diretórios de binários que o PATH de uma app GUI no macOS/Linux costuma omitir.
    fn extra_bin_dirs() -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = vec![
            PathBuf::from("/opt/homebrew/bin"), // Homebrew (Apple Silicon)
            PathBuf::from("/usr/local/bin"),    // Homebrew (Intel) / npm global / instaladores
            PathBuf::from("/opt/local/bin"),    // MacPorts
        ];
        if let Some(home) = dirs::home_dir() {
            for rel in [
                ".local/bin",      // instalador nativo da Claude CLI
                ".claude/local",   // instalação local / migrate-installer
                ".npm-global/bin", // prefixo npm comum
                ".bun/bin",        // Bun
                ".deno/bin",       // Deno
                ".asdf/shims",     // asdf
            ] {
                out.push(home.join(rel));
            }
            // nvm: ~/.nvm/versions/node/<versao>/bin (todas as versões instaladas).
            push_version_bins(&mut out, home.join(".nvm/versions/node"), "bin");
            // fnm: ~/.local/share/fnm/node-versions/<versao>/installation/bin.
            push_version_bins(
                &mut out,
                home.join(".local/share/fnm/node-versions"),
                "installation/bin",
            );
        }
        out
    }

    /// Acrescenta `<base>/<entrada>/<sub>` para cada subpasta de `base` (gestores de versões do node).
    fn push_version_bins(out: &mut Vec<PathBuf>, base: PathBuf, sub: &str) {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for e in entries.flatten() {
                let bin = e.path().join(sub);
                if bin.is_dir() {
                    out.push(bin);
                }
            }
        }
    }

    /// PATH atual + localizações habituais, sem duplicados. Cacheado (não muda em execução).
    fn path_dirs() -> &'static [PathBuf] {
        static CACHE: OnceLock<Vec<PathBuf>> = OnceLock::new();
        CACHE.get_or_init(|| {
            let mut seen = std::collections::HashSet::new();
            let mut dirs: Vec<PathBuf> = Vec::new();
            // Primeiro o PATH atual (respeita a ordem que o utilizador/SO definiu).
            if let Some(p) = std::env::var_os("PATH") {
                for d in std::env::split_paths(&p) {
                    if !d.as_os_str().is_empty() && seen.insert(d.clone()) {
                        dirs.push(d);
                    }
                }
            }
            // Depois as localizações que faltam ao PATH de apps GUI (só as que existem).
            for d in extra_bin_dirs() {
                if d.is_dir() && seen.insert(d.clone()) {
                    dirs.push(d);
                }
            }
            dirs
        })
    }

    pub fn augmented_path() -> String {
        std::env::join_paths(path_dirs())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default()
    }

    pub fn resolve(cmd: &str) -> Option<PathBuf> {
        let cmd = cmd.trim();
        if cmd.is_empty() {
            return None;
        }
        // Já é um caminho: usa-o tal como está se existir.
        if cmd.contains('/') {
            let p = PathBuf::from(cmd);
            return p.is_file().then_some(p);
        }
        // Nome simples: procura-o nos diretórios do PATH aumentado.
        for dir in path_dirs() {
            let full = dir.join(cmd);
            if full.is_file() {
                return Some(full);
            }
        }
        None
    }
}

#[cfg(windows)]
mod imp {
    use std::path::PathBuf;

    /// No Windows mantemos o PATH do processo (as apps GUI herdam-no do sistema).
    pub fn augmented_path() -> String {
        std::env::var("PATH").unwrap_or_default()
    }

    /// Sem resolução no Windows — o nome tal como está já funciona (comportamento atual).
    pub fn resolve(_cmd: &str) -> Option<PathBuf> {
        None
    }
}

pub use imp::{augmented_path, resolve};

/// Caminho a usar para lançar `cmd`: o resolvido (absoluto) se existir, senão o original
/// (deixa o SO procurar no PATH). No Windows é sempre o original.
pub fn launch_path(cmd: &str) -> String {
    resolve(cmd)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| cmd.to_string())
}
