//! Orquestração de subagentes: um planeador divide a tarefa em subtarefas isoladas,
//! os subagentes resolvem-nas em paralelo, e um sintetizador junta numa resposta final.
//! Só faz sentido na rota Claude API.

use anyhow::Result;
use futures_util::future::join_all;

use crate::providers::{claude_api, ChatMessage, LlmResponse, Source};

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

/// Pergunta ao modelo o que ainda falta investigar (devolve novas subtarefas ou nada).
fn critic_prompt(task: &str, findings: &str) -> String {
    format!(
        "Tarefa de investigação:\n{task}\n\nResultados obtidos até agora:\n{findings}\n\n\
O que ainda FALTA responder ou aprofundar? Responde APENAS com um array JSON de 1 a 4 subtarefas \
de pesquisa específicas para colmatar as lacunas. Se a investigação já estiver completa, responde []."
    )
}

/// Secção "## Fontes" em Markdown a partir das fontes acumuladas.
fn fontes_block(sources: &[Source]) -> String {
    if sources.is_empty() {
        return String::new();
    }
    let mut s = String::from("\n\n## Fontes\n");
    for (i, src) in sources.iter().enumerate() {
        let label = if src.title.trim().is_empty() {
            &src.url
        } else {
            &src.title
        };
        s.push_str(&format!("{}. [{}]({})\n", i + 1, label, src.url));
    }
    s
}

/// Orquestra subagentes. Com `web_search`, corre em **rondas iterativas** (pesquisa →
/// análise de lacunas → repesquisa, até `max_rounds`) e produz um relatório citado.
#[allow(clippy::too_many_arguments)]
pub async fn orchestrate<D, T>(
    api_key: &str,
    model: &str,
    max_tokens: u32,
    messages: &[ChatMessage],
    web_search: bool,
    max_rounds: u32,
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
    let mut sources: Vec<Source> = Vec::new();

    // 1. Planeador: divide a tarefa.
    let plan_prompt = format!(
        "Divide a tarefa seguinte em 2 a 5 subtarefas INDEPENDENTES, resolúveis em paralelo. \
Responde APENAS com um array JSON de strings (as subtarefas), nada mais. \
Se a tarefa não beneficiar de divisão, devolve um array com 1 elemento.\n\nTarefa: {task}"
    );
    let mut subtasks = match claude_api::messages(api_key, model, 1024, &[msg("user", plan_prompt)], false)
        .await
    {
        Ok(r) => {
            total_in += r.input_tokens;
            total_out += r.output_tokens;
            parse_subtasks(&r.text).unwrap_or_else(|| vec![task.clone()])
        }
        Err(_) => vec![task.clone()],
    };

    // Tarefa não divisível e sem pesquisa → resposta normal em streaming (sem overhead).
    if subtasks.len() <= 1 && !web_search {
        on_tool("plano", "tarefa única — sem divisão");
        let r = claude_api::messages_stream(
            api_key, model, max_tokens, messages, None, false,
            |d| on_delta(d), |_th| {}, |_t, _d| {},
        )
        .await?;
        return Ok(LlmResponse {
            text: r.text,
            input_tokens: total_in + r.input_tokens,
            output_tokens: total_out + r.output_tokens,
            reported_cost_usd: 0.0,
            sources: r.sources,
        });
    }

    let rounds = if web_search { max_rounds.clamp(1, 5) } else { 1 };
    let mut findings = String::new();
    let mut round = 0u32;

    // 2. Rondas: subagentes em paralelo → análise de lacunas → repetir.
    loop {
        round += 1;
        on_tool("ronda", &format!("{round}: {} subtarefas em paralelo", subtasks.len()));
        for (i, st) in subtasks.iter().enumerate() {
            on_tool("subagente", &format!("{round}.{} {}", i + 1, st));
        }

        let futures = subtasks.iter().map(|st| {
            let m = vec![msg("user", st.clone())];
            async move { claude_api::messages(api_key, model, max_tokens, &m, web_search).await }
        });
        let results = join_all(futures).await;
        for (i, (st, res)) in subtasks.iter().zip(results.iter()).enumerate() {
            match res {
                Ok(r) => {
                    total_in += r.input_tokens;
                    total_out += r.output_tokens;
                    for s in &r.sources {
                        if !sources.iter().any(|x| x.url == s.url) {
                            sources.push(s.clone());
                        }
                    }
                    findings.push_str(&format!("### (R{round}.{}) {}\n{}\n\n", i + 1, st, r.text));
                }
                Err(e) => {
                    findings.push_str(&format!("### (R{round}.{}) {}\n(erro: {e})\n\n", i + 1, st))
                }
            }
        }

        if round >= rounds {
            break;
        }

        // Análise de lacunas: novas subtarefas ou fim.
        on_tool("lacunas", &format!("ronda {round}: a analisar o que falta"));
        let gaps = match claude_api::messages(
            api_key,
            model,
            1024,
            &[msg("user", critic_prompt(&task, &findings))],
            false,
        )
        .await
        {
            Ok(r) => {
                total_in += r.input_tokens;
                total_out += r.output_tokens;
                parse_subtasks(&r.text)
            }
            Err(_) => None,
        };
        match gaps {
            Some(g) => subtasks = g,
            None => break, // investigação completa
        }
    }

    // 3. Sintetizador (streaming para o utilizador).
    on_tool("síntese", if web_search { "a redigir o relatório" } else { "a juntar os resultados" });
    let synth_system = if web_search {
        "Recebeste resultados de uma investigação (vários subagentes, possivelmente várias rondas). \
Escreve um RELATÓRIO final em Markdown — completo, estruturado (títulos, listas) e fiel aos resultados. \
NÃO inventes factos nem URLs. NÃO menciones 'subagentes' nem 'rondas'. NÃO adiciones secção de fontes \
(ela é acrescentada automaticamente)."
    } else {
        "Recebeste os resultados de vários subagentes que resolveram subtarefas de uma tarefa maior. \
Sintetiza uma resposta final coerente e completa — não menciones 'subagentes' nem a divisão interna."
    };
    let synth_user = format!("Tarefa original:\n{task}\n\nResultados:\n{findings}");
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

    let mut text = synth.text;
    let fontes = fontes_block(&sources);
    if !fontes.is_empty() {
        on_delta(&fontes);
        text.push_str(&fontes);
    }

    Ok(LlmResponse {
        text,
        input_tokens: total_in,
        output_tokens: total_out,
        reported_cost_usd: 0.0,
        sources,
    })
}
