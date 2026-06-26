---
name: resumir-pagina
description: "Resume uma página web. Usa esta skill quando o utilizador pedir para resumir, analisar ou extrair o essencial de um URL. Triggers: 'resume esta página', 'o que diz este link', 'resumir', 'analisa este site'."
---

# Resumir página

Quando o utilizador der um URL para resumir:

1. Abre o URL com `browser_navigate`.
2. Lê o conteúdo com `browser_read_text`.
3. Produz um resumo curto em português:
   - **Tema** numa frase.
   - **3 a 5 pontos** principais (bullets).
   - **Conclusão / call-to-action**, se existir.

Mantém o resumo fiel ao texto; não inventes factos que não estejam na página.
Se a página não tiver texto útil (login, paywall), diz isso em vez de adivinhar.
