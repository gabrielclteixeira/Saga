//! Descoberta de modelos Claude via a CLI interativa (rota "subscrição", sem API key).
//!
//! A CLI não expõe `/model` em modo `-p` (headless) — confirmado: `claude -p "/model"` devolve
//! "/model isn't available in this environment". Só existe dentro da sessão interativa (TUI).
//! Por isso corremos `claude` num PTY real (pseudo-terminal — pipes simples não bastam, a CLI
//! deteta `isatty()` e não desenha o menu), enviamos "/model" como se fosse escrito à mão, e
//! fazemos parsing best-effort do texto renderizado.
//!
//! Isto é screen-scraping de uma TUI que não foi feita para ser lida por máquina — é frágil a
//! qualquer mudança de wording/layout numa atualização da Claude CLI. Por isso devolvemos sempre
//! o texto bruto (sem ANSI) ao lado da lista extraída, para se o parsing falhar dar para depurar
//! sem adivinhar às cegas.
//!
//! Corre sempre numa pasta fixa (`scratch_dir`) que o utilizador tem de confiar manualmente uma
//! vez (correr `claude` aí num terminal normal e aceitar o diálogo de confiança) — nunca
//! respondemos a esse diálogo automaticamente; isso seria automatizar uma decisão de segurança
//! que existe precisamente para exigir uma pessoa a decidir.

use anyhow::{anyhow, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::mpsc;
use std::time::{Duration, Instant};

const READY_TIMEOUT: Duration = Duration::from_secs(20);
const MENU_TIMEOUT: Duration = Duration::from_secs(10);
const QUIET_WINDOW: Duration = Duration::from_millis(700);

/// Padrões (em minúsculas) que indicam que a pasta ainda não está confiada — nunca respondemos
/// a isto automaticamente, abortamos e explicamos ao utilizador o que fazer.
const TRUST_MARKERS: &[&str] = &["do you trust the files", "trust the files in this folder"];

/// Padrões que indicam que a CLI está pronta para receber um comando.
const READY_MARKERS: &[&str] = &["? for shortcuts", "try \""];

pub struct ModelDiscovery {
    pub models: Vec<String>,
    pub raw: String,
}

/// Pasta fixa e pré-confiada onde corremos a CLI só para esta funcionalidade. Isolada das
/// pastas de projeto reais para que confiar aqui uma vez não tenha qualquer efeito lateral.
pub fn scratch_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| anyhow!("{e}"))?
        .join("claude-cli-scratch");
    std::fs::create_dir_all(&dir).map_err(|e| anyhow!("não foi possível criar {}: {e}", dir.display()))?;
    Ok(dir)
}

/// Remove sequências de escape ANSI (CSI `ESC [ ... letra`, OSC `ESC ] ... BEL/ST`, e outras
/// `ESC letra`) de texto capturado de um terminal. Não é um parser de terminal completo — só o
/// suficiente para tirar o "lixo" visual e sobrar texto legível.
fn strip_ansi(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            if c != '\r' {
                out.push(c);
            }
            continue;
        }
        match chars.peek() {
            Some('[') => {
                chars.next(); // consome '['
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() || c2 == '~' {
                        break;
                    }
                }
            }
            Some(']') => {
                chars.next(); // consome ']'
                // OSC termina em BEL (\x07) ou ESC \ (ST)
                while let Some(&c2) = chars.peek() {
                    chars.next();
                    if c2 == '\u{7}' {
                        break;
                    }
                    if c2 == '\u{1b}' {
                        if chars.peek() == Some(&'\\') {
                            chars.next();
                        }
                        break;
                    }
                }
            }
            Some(_) => {
                chars.next(); // ESC + 1 caractere (ex.: ESC = / ESC >)
            }
            None => {}
        }
    }
    out
}

/// Extrai nomes/IDs de modelo do texto (já sem ANSI) do menu `/model`. Heurística best-effort:
/// linhas com um marcador de seleção comum seguido de um nome reconhecível de modelo.
fn parse_model_list(clean: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in clean.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        let lower = l.to_lowercase();
        let looks_like_model = ["opus", "sonnet", "haiku", "fable", "mythos"]
            .iter()
            .any(|k| lower.contains(k));
        if !looks_like_model {
            continue;
        }
        let cleaned = l
            .trim_start_matches(['❯', '>', '●', '○', '•', '-', '*', '│', '┃', ' '])
            .trim();
        if !cleaned.is_empty() && !out.iter().any(|x: &String| x == cleaned) {
            out.push(cleaned.to_string());
        }
    }
    out
}

/// Corre a CLI num PTY, envia "/model", captura e faz parsing do menu. Nunca seleciona nem
/// altera o modelo — fecha o menu com Escape antes de terminar a sessão.
pub fn discover(cli_path: &str, scratch: &std::path::Path) -> Result<ModelDiscovery> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 45,
        cols: 130,
        pixel_width: 0,
        pixel_height: 0,
    })?;

    let launch = crate::which::launch_path(cli_path);
    let mut cmd = CommandBuilder::new(&launch);
    cmd.cwd(scratch);
    cmd.env("PATH", crate::which::augmented_path());

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| anyhow!("não foi possível lançar a Claude CLI ('{cli_path}'): {e}"))?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;

    // Lê continuamente para um canal, para o lado principal poder aplicar timeouts.
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    // Fase 1: espera a CLI ficar pronta para input (ou deteta o diálogo de confiança).
    let mut acc = String::new();
    let deadline = Instant::now() + READY_TIMEOUT;
    let mut trust_prompt = false;
    loop {
        if Instant::now() > deadline {
            let _ = child.kill();
            log::warn!("[claude-cli-models] timeout à espera do prompt; saída: {}", strip_ansi(&acc));
            return Err(anyhow!(
                "A Claude CLI não ficou pronta a tempo. Isto pode acontecer se a interface mudou \
                 desde que este parsing foi escrito — vê os logs do Saga para a saída capturada."
            ));
        }
        match rx.recv_timeout(Duration::from_millis(300)) {
            Ok(chunk) => {
                acc.push_str(&String::from_utf8_lossy(&chunk));
                let clean_lower = strip_ansi(&acc).to_lowercase();
                if TRUST_MARKERS.iter().any(|m| clean_lower.contains(m)) {
                    trust_prompt = true;
                    break;
                }
                if READY_MARKERS.iter().any(|m| clean_lower.contains(m)) {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    if trust_prompt {
        let _ = child.kill();
        return Err(anyhow!(
            "Esta pasta ainda não está confiada pelo Claude Code: {}\n\
             Abre um terminal, corre `claude` nessa pasta uma vez e aceita o diálogo de confiança \
             manualmente — o Saga nunca responde a esse diálogo por ti. Depois disso o refresh \
             passa a funcionar sem pedir nada.",
            scratch.display()
        ));
    }

    // Fase 2: envia "/model" e espera o menu renderizar (usa uma janela de silêncio, porque
    // não há um marcador fiável de "o menu acabou de desenhar" — a TUI pode redesenhar várias
    // vezes por causa de animações).
    writer.write_all(b"/model\r")?;
    writer.flush()?;

    acc.clear();
    let deadline = Instant::now() + MENU_TIMEOUT;
    let mut last_change = Instant::now();
    loop {
        if Instant::now() > deadline {
            break;
        }
        match rx.recv_timeout(Duration::from_millis(150)) {
            Ok(chunk) => {
                acc.push_str(&String::from_utf8_lossy(&chunk));
                last_change = Instant::now();
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if !acc.is_empty() && last_change.elapsed() > QUIET_WINDOW {
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    let clean = strip_ansi(&acc);
    log::info!("[claude-cli-models] menu capturado ({} bytes brutos)", acc.len());

    // Fecha o menu sem escolher nada (Escape) e termina a sessão de forma limpa.
    let _ = writer.write_all(b"\x1b");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(200));
    let _ = writer.write_all(b"/exit\r");
    let _ = writer.flush();
    std::thread::sleep(Duration::from_millis(300));
    let _ = child.kill();

    let models = parse_model_list(&clean);
    if models.is_empty() {
        log::warn!("[claude-cli-models] parsing não encontrou modelos; saída bruta:\n{clean}");
    }
    Ok(ModelDiscovery { models, raw: clean })
}
