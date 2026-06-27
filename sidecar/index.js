// Sidecar Playwright para o Saga.
// Protocolo: recebe linhas JSON {id, action, params} no stdin e responde
// {id, ok, result} ou {id, ok:false, error} no stdout (uma linha por pedido).
//
// Setup: dentro de sidecar/  ->  npm install  &&  npx playwright install chromium

const { chromium } = require("playwright");
const readline = require("readline");
const path = require("path");

let context = null;
let page = null;

async function ensure() {
  if (context) return;
  const userDataDir = process.env.SAGA_USER_DATA_DIR || "./.saga-browser";
  // Persistent context => sessão/login mantêm-se entre execuções.
  context = await chromium.launchPersistentContext(userDataDir, { headless: false });
  page = context.pages()[0] || (await context.newPage());
}

async function handle(action, params) {
  if (action !== "pdf") await ensure(); // pdf usa um browser headless próprio
  switch (action) {
    case "navigate": {
      await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return await page.title();
    }
    case "read_text": {
      const text = await page.evaluate(() => (document.body ? document.body.innerText : ""));
      return text.slice(0, 8000);
    }
    case "click": {
      await page.click(params.selector, { timeout: 15000 });
      return "ok";
    }
    case "fill": {
      await page.fill(params.selector, params.text ?? "", { timeout: 15000 });
      return "ok";
    }
    case "screenshot": {
      const dir = process.env.SAGA_USER_DATA_DIR || ".";
      const out = path.join(dir, `shot-${Date.now()}.png`);
      await page.screenshot({ path: out, fullPage: false });
      return out;
    }
    case "pdf": {
      // page.pdf() só funciona em headless → usa uma instância dedicada (não a sessão persistente).
      const dir = process.env.SAGA_USER_DATA_DIR || ".";
      const slug =
        String(params.title || "documento")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 40) || "documento";
      const out = params.path || path.join(dir, `${slug}-${Date.now()}.pdf`);
      const browser = await chromium.launch({ headless: true });
      try {
        const p = await browser.newPage();
        await p.setContent(String(params.html || ""), { waitUntil: "networkidle" });
        const docTitle = String(params.title || "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        await p.pdf({
          path: out,
          format: "A4",
          printBackground: true,
          displayHeaderFooter: true,
          // Cabeçalho discreto com o título · rodapé com número de página (centrado).
          headerTemplate: `<div style="width:100%;font-size:7pt;color:#9aa7b4;padding:0 16mm;font-family:'Segoe UI',sans-serif;">${docTitle}</div>`,
          footerTemplate:
            '<div style="width:100%;font-size:7pt;color:#9aa7b4;text-align:center;font-family:\'Segoe UI\',sans-serif;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
          margin: { top: "20mm", bottom: "18mm", left: "16mm", right: "16mm" },
        });
      } finally {
        await browser.close();
      }
      return out;
    }
    default:
      throw new Error("ação desconhecida: " + action);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (raw) => {
  const line = raw.trim();
  if (!line) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return; // ignora linhas não-JSON
  }
  const { id, action, params } = req;
  try {
    const result = await handle(action, params || {});
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\n");
  } catch (e) {
    const error = (e && e.message) || String(e);
    process.stdout.write(JSON.stringify({ id, ok: false, error }) + "\n");
  }
});

async function shutdown() {
  try {
    if (context) await context.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
