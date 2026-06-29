//! Camada "reasoning": análise leve do pedido ANTES de responder. Por agora classifica a INTENÇÃO
//! (determinística, barata) — o deep-research usa-a para escolher a estratégia de decomposição e a UI
//! mostra-a na metadata. Pensada para ser partilhada (clarificação / decisão-de-web no futuro).

/// Intenção do pedido. Extensível (Local/News/HowTo…) quando fizer sentido.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Intent {
    /// Quer comprar / encontrar produtos, lojas ou links de compra.
    Shopping,
    /// Tudo o resto (pergunta de investigação geral).
    General,
}

impl Intent {
    /// Etiqueta estável para logs e UI (a UI traduz).
    pub fn as_str(&self) -> &'static str {
        match self {
            Intent::Shopping => "shopping",
            Intent::General => "general",
        }
    }
}

/// Sinais transacionais. Mantidos de ALTA precisão — NÃO incluímos "preço"/"links" sozinhos (ambíguos:
/// research vs compra) para baixar falsos positivos.
const SHOPPING_SUBSTR: &[&str] = &[
    "comprar",
    "onde comprar",
    "onde compro",
    "encomendar",
    "adquirir",
    "onde vendem",
    "onde arranjo",
    "where to buy",
    "purchase",
];
/// Sinais que só contam como PALAVRA inteira (evita substrings indesejadas, ex.: "buy" em "buying" é ok,
/// mas "loja" em "relojaria" não deve disparar).
const SHOPPING_WORDS: &[&str] = &["loja", "lojas", "shop", "buy"];

/// Classifica a intenção do texto (determinístico). Shopping quando há um sinal transacional claro.
pub fn classify_intent(text: &str) -> Intent {
    let lower = text.to_lowercase();
    if SHOPPING_SUBSTR.iter().any(|s| lower.contains(s)) {
        return Intent::Shopping;
    }
    let is_word = lower
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .any(|w| SHOPPING_WORDS.contains(&w));
    if is_word {
        return Intent::Shopping;
    }
    Intent::General
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shopping_vs_general() {
        assert_eq!(classify_intent("onde comprar uma RTX 5090"), Intent::Shopping);
        assert_eq!(classify_intent("links de onde comprar cada componente"), Intent::Shopping);
        assert_eq!(classify_intent("where to buy this CPU"), Intent::Shopping);
        assert_eq!(classify_intent("que lojas em Portugal vendem isto"), Intent::Shopping);
        // "preço"/"links" sozinhos NÃO disparam (ambíguos).
        assert_eq!(classify_intent("porque é que o preço dos GPUs subiu?"), Intent::General);
        assert_eq!(classify_intent("explica o que é PCIe 5.0"), Intent::General);
        // Palavra inteira evita substrings (ex.: relojoaria não é "loja").
        assert_eq!(classify_intent("história da relojoaria suíça"), Intent::General);
    }
}
