//! Orquestração de subagentes: um planeador divide a tarefa em subtarefas isoladas,
//! os subagentes resolvem-nas em paralelo, e um sintetizador junta numa resposta final.
//! Só faz sentido na rota Claude API.

use anyhow::Result;
use futures_util::future::join_all;

use crate::providers::{claude_api, ChatMessage, LlmResponse};

const MAX_SUBTASKS: usize = 5;

fn last_user(messages: &[ChatMessage]) -> String {
    messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default()
}

fn msg(role: &str, content: String) -> ChatMessage {
    ChatMessage {
        role: role.into(),
        content,
        attachments: Vec::new(),
    }
}

/// Extrai o primeiro array JSON de strings do texto do planeador.
fn parse_subtasks(text: &str) -> Option<Vec<String>> {
    let start = text.find('[')?;
    let end = text.rfind(']')?;
    let arr: Vec<String> = serde_json::from_str(&text[start..=end]).ok()?;
    let arr: Vec<String> = arr
        .into_iter()
        .filter(|s| !s.trim().is_empty())
        .take(MAX_SUBTASKS)
        .collect();
    (!arr.is_empty()).then_some(arr)
}

pub async fn orchestrate<D, T>(
    api_key: &str,
    model: &str,
    max_tokens: u32,
    messages: &[ChatMessage],
    mut on_delta: D,
    mut on_tool: T,
) -> Result<LlmResponse>
where
    D: FnMut(&str),
    T: FnMut(&str, &str),
{
    let task = last_user(messages);
    let mut total_in = 0u64;
    let mut total_out = 0u64;

    // 1. Planeador: divide a tarefa.
    let plan_prompt = format!(
        "Divide a tarefa seguinte em 2 a 5 subtarefas INDEPENDENTES, resolúveis em paralelo. \
Responde APENAS com um array JSON de strings (as subtarefas), nada mais. \
Se a tarefa não beneficiar de divisão, devolve um array com 1 elemento.\n\nTarefa: {task}"
    );
    let subtasks = match claude_api::messages(api_key, model, 1024, &[msg("user", plan_prompt)]).await
    {
        Ok(r) => {
            total_in += r.input_tokens;
            total_out += r.output_tokens;
            parse_subtasks(&r.text).unwrap_or_else(|| vec![task.clone()])
        }
        Err(_) => vec![task.clone()],
    };

    // Tarefa não divisível → resposta normal em streaming (sem overhead de subagentes).
    if subtasks.len() <= 1 {
        on_tool("plano", "tarefa única — sem divisão");
        let r = claude_api::messages_stream(
            api_key,
            model,
            max_tokens,
            messages,
            None,
            false,
            |d| on_delta(d),
            |_th| {},
            |_t, _d| {},
        )
        .await?;
        return Ok(LlmResponse {
            text: r.text,
            input_tokens: total_in + r.input_tokens,
            output_tokens: total_out + r.output_tokens,
            reported_cost_usd: 0.0,
        });
    }

    on_tool("plano", &format!("{} subtarefas em paralelo", subtasks.len()));
    for (i, st) in subtasks.iter().enumerate() {
        on_tool("subagente", &format!("{}. {}", i + 1, st));
    }

    // 2. Subagentes em paralelo (cada um com contexto próprio mínimo).
    let futures = subtasks.iter().map(|st| {
        let m = vec![msg("user", st.clone())];
        async move { claude_api::messages(api_key, model, max_tokens, &m).await }
    });
    let results = join_all(futures).await;

    let mut blocks = String::new();
    for (i, (st, res)) in subtasks.iter().zip(results.iter()).enumerate() {
        match res {
            Ok(r) => {
                total_in += r.input_tokens;
                total_out += r.output_tokens;
                blocks.push_str(&format!("### Subtarefa {}: {}\n{}\n\n", i + 1, st, r.text));
            }
            Err(e) => blocks.push_str(&format!("### Subtarefa {}: {}\n(erro: {e})\n\n", i + 1, st)),
        }
    }

    // 3. Sintetizador (streaming para o utilizador).
    on_tool("síntese", "a juntar os resultados");
    let synth_system = "Recebeste os resultados de vários subagentes que resolveram subtarefas de \
uma tarefa maior. Sintetiza uma resposta final coerente e completa para o utilizador — não menciones \
'subagentes' nem a divisão interna.";
    let synth_user = format!("Tarefa original:\n{task}\n\nResultados:\n{blocks}");
    let synth = claude_api::messages_stream(
        api_key,
        model,
        max_tokens,
        &[msg("system", synth_system.into()), msg("user", synth_user)],
        None,
        false,
        |d| on_delta(d),
        |_th| {},
        |_t, _d| {},
    )
    .await?;
    total_in += synth.input_tokens;
    total_out += synth.output_tokens;

    Ok(LlmResponse {
        text: synth.text,
        input_tokens: total_in,
        output_tokens: total_out,
        reported_cost_usd: 0.0,
    })
}
