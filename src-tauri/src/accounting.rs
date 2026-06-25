//! Contabilidade de tokens: quanto se gastou no Claude vs quanto se poupou ao servir localmente.

use serde::Serialize;

/// Preços aproximados por milhão de tokens (USD), input/output. Junho 2026.
fn price_per_mtok(model: &str) -> (f64, f64) {
    let m = model.to_lowercase();
    if m.contains("opus") {
        (5.0, 25.0)
    } else if m.contains("sonnet") {
        (3.0, 15.0)
    } else if m.contains("haiku") {
        (1.0, 5.0)
    } else if m.contains("fable") {
        (10.0, 50.0)
    } else {
        // fallback conservador (haiku)
        (1.0, 5.0)
    }
}

pub fn cost_usd(model: &str, input_tokens: u64, output_tokens: u64) -> f64 {
    let (in_price, out_price) = price_per_mtok(model);
    (input_tokens as f64 / 1_000_000.0) * in_price
        + (output_tokens as f64 / 1_000_000.0) * out_price
}

#[derive(Default, Clone, Debug, Serialize)]
pub struct Accounting {
    pub local_requests: u64,
    pub claude_requests: u64,
    pub claude_input_tokens: u64,
    pub claude_output_tokens: u64,
    /// Tokens estimados que teriam ido ao Claude mas foram servidos localmente.
    pub tokens_served_local: u64,
    /// Tokens poupados por compressão de contexto antes de escalar para o Claude.
    pub tokens_saved_compression: u64,
    pub claude_cost_usd: f64,
}

impl Accounting {
    pub fn record_local(&mut self, total_tokens: u64) {
        self.local_requests += 1;
        self.tokens_served_local += total_tokens;
    }

    pub fn record_claude(
        &mut self,
        model: &str,
        input_tokens: u64,
        output_tokens: u64,
        reported_cost_usd: f64,
        tokens_saved_compression: u64,
    ) {
        self.claude_requests += 1;
        self.claude_input_tokens += input_tokens;
        self.claude_output_tokens += output_tokens;
        self.tokens_saved_compression += tokens_saved_compression;
        let cost = if reported_cost_usd > 0.0 {
            reported_cost_usd
        } else {
            cost_usd(model, input_tokens, output_tokens)
        };
        self.claude_cost_usd += cost;
    }
}
