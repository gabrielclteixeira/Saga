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
  await ensure();
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
