//! Extração de texto de documentos anexados (PDF, Word, Excel, texto simples).
//! Recebe os bytes (decodificados de base64 no comando) e devolve texto plano,
//! para ser injetado no contexto do modelo. A extração é defensiva: qualquer
//! falha devolve uma mensagem curta em vez de abortar o pedido.

use std::io::Cursor;

/// Limite de caracteres por documento (evita rebentar o contexto/BD com ficheiros enormes).
const MAX_CHARS: usize = 200_000;

/// Extrai texto de um documento a partir do nome (para a extensão) e dos bytes.
pub fn extract(name: &str, bytes: &[u8]) -> String {
    let ext = name
        .rsplit('.')
        .next()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    let text = match ext.as_str() {
        "pdf" => extract_pdf(bytes),
        "docx" => extract_docx(bytes),
        "xlsx" | "xlsm" | "xls" | "ods" => extract_spreadsheet(bytes),
        // Texto simples e formatos legíveis como texto.
        _ => String::from_utf8_lossy(bytes).into_owned(),
    };
    truncate(text)
}

fn truncate(mut s: String) -> String {
    if s.chars().count() > MAX_CHARS {
        let cut: String = s.chars().take(MAX_CHARS).collect();
        s = format!("{cut}\n\n[…documento truncado em {MAX_CHARS} caracteres]");
    }
    s
}

fn extract_pdf(bytes: &[u8]) -> String {
    match pdf_extract::extract_text_from_mem(bytes) {
        Ok(t) if !t.trim().is_empty() => t,
        Ok(_) => "[PDF sem texto extraível (pode ser digitalizado/imagem)]".into(),
        Err(e) => format!("[não foi possível ler o PDF: {e}]"),
    }
}

/// DOCX é um zip; o texto vive em `word/document.xml`. Extrai os `<w:t>` sem
/// dependências pesadas: separa parágrafos por `</w:p>` e remove as tags.
fn extract_docx(bytes: &[u8]) -> String {
    let mut zip = match zip::ZipArchive::new(Cursor::new(bytes)) {
        Ok(z) => z,
        Err(e) => return format!("[não foi possível abrir o .docx: {e}]"),
    };
    let mut xml = String::new();
    {
        use std::io::Read;
        match zip.by_name("word/document.xml") {
            Ok(mut f) => {
                if f.read_to_string(&mut xml).is_err() {
                    return "[.docx ilegível]".into();
                }
            }
            Err(_) => return "[.docx sem word/document.xml]".into(),
        }
    }
    let text = strip_docx_xml(&xml);
    if text.trim().is_empty() {
        "[documento Word sem texto]".into()
    } else {
        text
    }
}

/// Converte o XML do Word em texto: quebra de linha por parágrafo, tags removidas.
fn strip_docx_xml(xml: &str) -> String {
    let with_breaks = xml
        .replace("</w:p>", "\n")
        .replace("<w:br/>", "\n")
        .replace("<w:tab/>", "\t");
    let mut out = String::with_capacity(with_breaks.len() / 2);
    let mut in_tag = false;
    for ch in with_breaks.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

/// Lê uma folha de cálculo (xlsx/xls/ods) e devolve cada folha como linhas separadas por tab.
fn extract_spreadsheet(bytes: &[u8]) -> String {
    use calamine::{Data, Reader};
    let cursor = Cursor::new(bytes.to_vec());
    let mut wb = match calamine::open_workbook_auto_from_rs(cursor) {
        Ok(wb) => wb,
        Err(e) => return format!("[não foi possível abrir a folha de cálculo: {e}]"),
    };
    let mut out = String::new();
    let sheets = wb.sheet_names().to_vec();
    for name in sheets {
        if let Ok(range) = wb.worksheet_range(&name) {
            if range.is_empty() {
                continue;
            }
            out.push_str(&format!("# {name}\n"));
            for row in range.rows() {
                let cells: Vec<String> = row
                    .iter()
                    .map(|c| match c {
                        Data::Empty => String::new(),
                        Data::String(s) => s.clone(),
                        Data::Float(f) => {
                            // Inteiros sem casas decimais ficam mais limpos.
                            if f.fract() == 0.0 {
                                format!("{}", *f as i64)
                            } else {
                                f.to_string()
                            }
                        }
                        Data::Int(i) => i.to_string(),
                        Data::Bool(b) => b.to_string(),
                        Data::DateTime(d) => d.to_string(),
                        other => other.to_string(),
                    })
                    .collect();
                out.push_str(&cells.join("\t"));
                out.push('\n');
            }
            out.push('\n');
        }
    }
    if out.trim().is_empty() {
        "[folha de cálculo vazia]".into()
    } else {
        out
    }
}
