---
name: resumir-url
description: "Abre um URL, lê o conteúdo e devolve um resumo curto."
argument-hint: o URL a resumir
---

Tarefa: resumir a página em **$ARGUMENTS**.

Passos:
1. `browser_navigate` para o URL.
2. `browser_read_text` para obter o texto visível.
3. Escreve um resumo em português: tema numa frase, 3–5 pontos principais, e
   uma conclusão se existir.

Não inventes conteúdo que não esteja na página. Se não conseguires aceder
(login/paywall), diz isso claramente em vez de adivinhar.
