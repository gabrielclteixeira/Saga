# Saga — Guia de design (sistema visual)

> Companheiro do **brand brief** (`docs/brand/azulejo-brief.md`). O brief define a **identidade**
> azulejo "Caravel" (paleta, ícone, painel hero, tema). **Este documento** define como **construir UI**
> com ela: tokens, escalas, ícones, componentes e convenções. Fonte de verdade do código:
> tokens em `src/style.css` (`:root`), ícones em `ICON_PATHS` (`src/main.ts`).
>
> Estado: **descritivo** — documenta o que existe hoje. Onde noto desvios à escala, marco com _(outlier)_.

---

## 1. Fundações

### 1.1 Cor (tokens)

Tema **claro azulejo** por omissão; **escuro cobalto** via `prefers-color-scheme: dark`. Nunca usar hex
fixo no código — sempre `var(--token)`.

| Token         | Claro      | Escuro     | Papel                                              |
|---------------|------------|------------|----------------------------------------------------|
| `--bg`        | `#f4f1e9`  | `#0e1d33`  | Fundo da app (glaze morno / noite cobalto)         |
| `--bg-2`      | `#eaf0f4`  | `#13294a`  | Superfícies (cards, diálogos, barras)              |
| `--bg-3`      | `#dde8f0`  | `#1a3357`  | Superfície elevada / hover                         |
| `--border`    | `#b9cdde`  | `#29456f`  | Linhas, contornos (1px)                            |
| `--text`      | `#1c3f73`  | `#eaf1f7`  | Tinta cobalto / branco-glaze                       |
| `--muted`     | `#5a7596`  | `#8fa6c2`  | Texto secundário, legendas, ícones discretos       |
| `--accent`    | `#2f6ea5`  | `#6fa8d6`  | Cobalto — ação primária, foco, links               |
| `--on-accent` | `#f4f1e9`  | `#0e1d33`  | Texto/ícone sobre o accent                         |
| `--local`     | `#4f8a6d`  | `#5fae87`  | **Semântico:** rota local · sucesso · poupança     |
| `--claude`    | `#d98e3c`  | `#e0a45a`  | **Semântico:** rota Claude · ocre (o único quente) |
| `--danger`    | `#c0413b`  | `#f08a8a`  | Erro, apagar, estado crítico                       |

**Neutros enviesados a azul** (border/muted puxam ao cobalto) — escolhidos, não cinzentos genéricos.
**Um só quente:** o ocre (`--claude`). Cor semântica (local/claude/danger) é separada do accent.

### 1.2 Tipografia

Família: **Inter**, com fallback `-apple-system, "Segoe UI", Roboto, sans-serif`. O chat escala por
`--font-scale` (Definições → Aparência).

| px   | Uso                                                        |
|------|------------------------------------------------------------|
| 11   | Micro: legendas, badges de capacidade, dicas               |
| 12   | Secundário: metadados, código inline, descrições de cards  |
| 13   | **UI por omissão**: corpo, itens de lista, botões          |
| 14   | Ênfase: nomes, rótulos fortes                              |
| 16   | Inputs / composer                                          |
| 18   | Cabeçalho de secção (`h3`)                                 |
| 22   | Título de diálogo / página (`h2`)                          |

_(outliers: 9 / 10 / 11.5 / 12.5 px aparecem pontualmente — arredondar à escala quando possível.)_

Pesos: **400** corpo · **500** medium · **600** semibold (rótulos, `strong`) · **700** títulos e badges.
_(650/800 ocasionais.)_ Usar `font-variant-numeric: tabular-nums` em colunas de números (tokens, custos).

### 1.3 Espaçamento

Grelha base **4px**. Passos usados: **4 · 6 · 8 · 10 · 12 · 16 · 20 · 24**. Compor com
`flex`/`grid` + `gap` (não margens por-elemento). Densidade de ferramenta desktop: paddings de 6–10px.

### 1.4 Raio

| Raio    | Uso                                                       |
|---------|-----------------------------------------------------------|
| `4px`   | xs — código, badges minúsculos                            |
| `6px`   | sm — checkbox, chips pequenos                             |
| `8px`   | **md (default)** — botões, inputs, itens de lista          |
| `10px`  | lg — cards e painéis                                      |
| `12px`  | xl — `--radius`; cards grandes                            |
| `14px`  | diálogos                                                  |
| `999px` | pill — `chip-toggle`, seletor de rota, barra de pesquisa  |

### 1.5 Contornos e profundidade

Contorno base **1px solid `var(--border)`** (1.5px na checkbox custom). **Sem sombras** por omissão —
a profundidade vem de **camadas** (`--bg` → `--bg-2` → `--bg-3`), não de `box-shadow`.

---

## 2. Iconografia

Ícones **monocromáticos de linha**, grelha 24, `stroke="currentColor"` largura **1.8**, `linecap`/
`linejoin` round. Definidos em `ICON_PATHS` e renderizados por `icon(name)` (`src/main.ts`).

- **Conjunto:** search, nodes, brain, eye, tool, hash, refresh, escalate, pencil, doc, play, sparkles,
  download, gear, export, book, chevron, info, list, x, check, circle.
- **Tamanhos:** 14px em botões com rótulo · 15px no `icon-x` · maiores no rail/cabeçalho.
- **Regra:** **sem emojis** na UI — usar sempre `icon()`. Ícone novo → acrescentar a `ICON_PATHS`.

---

## 3. Componentes

| Componente        | Especificação                                                                                  |
|-------------------|------------------------------------------------------------------------------------------------|
| **Botão ghost**   | Secundário. Transparente, `1px var(--border)`, raio 8, padding `6×12`, min-height 32, 12px, ícone 14px. Hover: fundo `--bg-3`, texto `--text`. |
| **Botão primary** | Ação principal. Fundo `--accent`, texto `--on-accent`, raio 8, padding `7×16`, peso 600, min-height 34. |
| **icon-btn**      | Só-ícone, no cabeçalho. Discreto, ícone em `currentColor`.                                      |
| **icon-x**        | Só-ícone quadrado 30×30 para apagar/fechar. `--muted`; hover → contorno e cor `--danger`.       |
| **chip-toggle**   | Toggle pill (raio 999) com ícone + rótulo (composer). Ativo: realce com `--accent`.            |
| **Checkbox**      | Custom **global** (`input[type=checkbox]`): 18px, raio 6, `1.5px` contorno; marcado enche com `--accent` + checkmark animado; foco `2px var(--accent)`. |
| **Input/textarea**| Fundo `--bg`, `1px var(--border)`, raio 8; foco realça com `--accent`.                          |
| **Card / item**   | `.ws-item`/`.mcp-item`/`.act-row`/`.model-item`: fundo `--bg-2`, `1px var(--border)`, raio 8–10, padding 6–10, layout flex + gap. Desativado: `opacity ~0.55`. |
| **Badge de rota** | `.badge` peso 700 + `letter-spacing 0.4px`; cor por rota (local→`--local`, claude→`--claude`).  |
| **Rail / nav**    | Coluna de ícones+rótulo à esquerda; item ativo realçado.                                        |

---

## 4. Padrões

- **Semântica de rota:** local = verde `--local`; Claude = ocre `--claude`. Usada em badges e no seletor
  de rota. Mantém a associação cor↔rota em toda a UI.
- **Estado (action_log / status):** OK → `--local` · ERRO → `--danger` · em execução/pendente →
  `--accent`/`--claude`. Codificar estado na **forma e na cor** (pill/cor), legível num relance.
- **Interação:** hover (contorno→`--accent` ou fundo→`--bg-3`) · foco `2px solid var(--accent)` com
  `outline-offset` · desativado `opacity 0.5–0.55` + `cursor: default`.
- **Densidade:** ferramenta desktop — texto 12–13px, paddings 6–10px, listas compactas.

---

## 5. Convenções (faz / não faz)

- ✅ **Tokens, nunca hex fixo.** Toda a cor vem de `var(--…)` (suporta claro/escuro automaticamente).
- ✅ **`icon()` monocromático, nunca emojis** na UI. Ícone novo → `ICON_PATHS`.
- ✅ **Layout por `gap`** (flex/grid), não margens que colapsam/duplicam.
- ✅ **`[hidden]` esconde sempre** (regra global `[hidden]{display:none!important}` — classes com
  `display:` não anulam o atributo).
- ✅ **Profundidade por camadas** (`--bg`/`--bg-2`/`--bg-3`), não sombras.
- ❌ Não introduzir novas cores fora da paleta azulejo (cobalto + ocre + glaze + semânticas).
- ❌ Não duplicar entradas i18n; a chave PT é o texto mostrado — sincronizar chave + valor EN + `t()`.

---

## 6. Fonte de verdade
- **Tokens / temas:** `src/style.css` (`:root` + `@media (prefers-color-scheme: dark)`).
- **Ícones:** `ICON_PATHS` em `src/main.ts` (`icon()`).
- **Identidade / marca:** `docs/brand/azulejo-brief.md`.
- **Vista visual:** style-guide renderizado (Artifact) — espelha este documento.
