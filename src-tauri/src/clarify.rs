//! Fase de esclarecimento do Plan mode.
//!
//! Separa a DETEÇÃO da GERAÇÃO, porque a literatura mostra que pôr o modelo a auto-julgar "isto é
//! ambíguo?" é pouco fiável (tende a marcar perguntas claras como ambíguas), enquanto um detetor
//! determinístico com features baratas é mais robusto — sobretudo em modelos pequenos.
//!
//! - `specificity` (L1, determinístico, sem modelo): filtro de recall — deixa passar as mensagens
//!   claramente específicas e sinaliza as vagas.
//! - `clarifying_questions` (slots, EXTRAÇÃO — tarefa fácil): só corre quando vago; o modelo diz o
//!   que FALTA. Devolve `[]` quando já há o essencial, vetando os falsos positivos da L1.

use crate::planner::{clean_step, lean_for_draft, parse_steps, with_instruction};
use crate::providers::ollama::{self, GenOpts};
use crate::providers::{claude_api, ChatMessage};
use crate::settings::Settings;

/// Palavras deíticas/referenciais (PT+EN). Sem um referente claro, sinalizam ambiguidade
/// pragmática — a maior classe de ambiguidade na literatura.
const DEICTIC: &[&str] = &[
    "isto", "isso", "aquilo", "este", "esse", "aquele", "esta", "essa", "aquela", "isos", "tal",
    "this", "that", "those", "these", "it",
];

#[derive(Debug, PartialEq, Eq)]
pub enum Specificity {
    Clear,
    Vague,
}

/// Heurística determinística (L1): a mensagem traz constraints concretas suficientes para planear?
/// Soma sinais de especificidade (quantidades, dinheiro, comprimento) e penaliza deíticos sem
/// referente. Calibrado para errar do lado de NÃO chatear nas mensagens claramente específicas;
/// quando devolve `Vague`, é a extração de slots que decide se há mesmo algo a perguntar.
pub fn specificity(task: &str) -> Specificity {
    let lower = task.to_lowercase();
    let words: Vec<&str> = lower.split_whitespace().collect();
    let n_words = words.len();
    // Palavras que contêm um dígito ≈ quantidades (orçamento, VRAM, tamanho de modelo "70b", "q4").
    let n_numbers = words.iter().filter(|w| w.chars().any(|c| c.is_ascii_digit())).count();
    let has_money = task.contains('€') || task.contains('$') || lower.contains("eur") || lower.contains("usd");
    let n_deictic = words
        .iter()
        .filter(|w| {
            let bare = w.trim_matches(|c: char| !c.is_alphanumeric());
            DEICTIC.contains(&bare)
        })
        .count();

    // Mensagens muito curtas e sem quantidades → quase sempre vagas.
    if n_words <= 6 && n_numbers == 0 {
        return Specificity::Vague;
    }
    let mut score: i32 = 0;
    if n_words >= 12 {
        score += 1;
    }
    if n_words >= 25 {
        score += 1;
    }
    score += n_numbers.min(3) as i32;
    if has_money {
        score += 1;
    }
    score -= n_deictic.min(2) as i32;

    if score >= 2 {
        Specificity::Clear
    } else {
        Specificity::Vague
    }
}

/// Gera 1-3 perguntas de esclarecimento por EXTRAÇÃO de slots em falta. Devolve vazio quando já há
/// o essencial (o modelo veta) ou se a chamada falhar. Acumula tokens em `total_in/out`.
pub async fn clarifying_questions(
    settings: &Settings,
    use_api: bool,
    model: &str,
    messages: &[ChatMessage],
    base_opts: GenOpts,
    total_in: &mut u64,
    total_out: &mut u64,
) -> Vec<String> {
    let instruction = "[ESCLARECER] Antes de planear, vê se a minha ÚLTIMA mensagem (no contexto desta \
conversa) já tem o ESSENCIAL para um bom plano: objetivo, escala/dimensão, restrições/orçamento, \
contexto/região e formato. Se já tem o essencial, responde APENAS com []. Caso contrário, faz 1 a 3 \
perguntas CURTAS e concretas sobre o que FALTA (uma por elemento em falta). NÃO planeies nem respondas à \
tarefa. Responde APENAS com um array JSON de strings (as perguntas), nada mais.";
    // Contexto enxuto + instrução na última mensagem (mesmo padrão do rascunho do plano).
    let msgs = with_instruction(&lean_for_draft(messages), instruction);
    let opts = GenOpts { num_predict: Some(256), temperature: Some(0.2), ..base_opts };

    let text = if use_api {
        claude_api::messages(&settings.claude_api_key, model, settings.claude_max_tokens, &msgs, false)
            .await
            .map(|r| {
                *total_in += r.input_tokens;
                *total_out += r.output_tokens;
                r.text
            })
            .unwrap_or_default()
    } else {
        ollama::chat_stream(&settings.ollama_endpoint, model, &msgs, opts, false, |_| {}, |_| {})
            .await
            .map(|r| {
                *total_in += r.input_tokens;
                *total_out += r.output_tokens;
                r.text
            })
            .unwrap_or_default()
    };
    let mut qs = parse_steps(&clean_step(&text));
    qs.truncate(3);
    qs
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vague_short_prompts() {
        assert_eq!(specificity("Quero uma máquina para LLMs locais"), Specificity::Vague);
        assert_eq!(specificity("I want a machine for local LLMs"), Specificity::Vague);
        assert_eq!(specificity("ajuda-me com isto"), Specificity::Vague);
        assert_eq!(specificity("preços de GPUs?"), Specificity::Vague);
    }

    #[test]
    fn clear_specific_prompts() {
        assert_eq!(
            specificity("Máquina ~€2000, correr Llama 70B Q4 em Portugal"),
            Specificity::Clear
        );
        assert_eq!(
            specificity("Build a PC around €2500 to run 70B models locally in the EU"),
            Specificity::Clear
        );
    }

    #[test]
    fn longish_but_vague_asks() {
        // Sem orçamento, tamanho de modelo nem região → ainda vago (o utilizador quer ser perguntado).
        assert_eq!(
            specificity("Quero fazer uma máquina boa para hospedar LLMs locais, quais os preços e onde comprar"),
            Specificity::Vague
        );
    }
}
