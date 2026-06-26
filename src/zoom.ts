//! Zoom da interface: escala o webview (texto + layout) e persiste o nível.
//! Atalhos Ctrl/⌘ + / − / 0 e Ctrl/⌘ + roda do rato.

import { getCurrentWebview } from "@tauri-apps/api/webview";

const KEY = "saga.zoom";
const MIN = 0.6;
const MAX = 2.4;
const STEP = 0.1;

let zoom = clamp(parseFloat(localStorage.getItem(KEY) || "1") || 1);
let onChange: ((z: number) => void) | null = null;

function clamp(z: number): number {
  return Math.min(MAX, Math.max(MIN, Math.round(z * 100) / 100));
}

async function apply() {
  localStorage.setItem(KEY, String(zoom));
  try {
    await getCurrentWebview().setZoom(zoom);
  } catch {
    // a correr fora do webview (browser puro em dev) — ignora
  }
  onChange?.(zoom);
}

export function getZoom(): number {
  return zoom;
}

export function setZoom(z: number) {
  zoom = clamp(z);
  void apply();
}

export function nudgeZoom(delta: number) {
  setZoom(zoom + delta);
}

export function resetZoom() {
  setZoom(1);
}

/** Regista um callback para atualizar a UI quando o zoom muda (chamado já com o valor atual). */
export function onZoomChange(cb: (z: number) => void) {
  onChange = cb;
  cb(zoom);
}

/** Aplica o zoom guardado e liga os atalhos de teclado/rato. */
export function initZoom() {
  void apply();
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        nudgeZoom(STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        nudgeZoom(-STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        resetZoom();
      }
    },
    { passive: false }
  );
  window.addEventListener(
    "wheel",
    (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      nudgeZoom(e.deltaY < 0 ? STEP : -STEP);
    },
    { passive: false }
  );
}
