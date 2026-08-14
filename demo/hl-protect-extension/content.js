// Atticus Protect — demo toggle (content script).
//
// Renders ONE small element — a "Protect" toggle — into the live Hyperliquid positions UI, styled
// to sit naturally in their dark theme. That placement is the only staged pixel of the demo (and is
// disclosed); flipping the toggle calls the LOCAL Atticus demo service, which reads the real
// position, prices the real collar off the live OKX book, and (in okx modes) executes real hedge
// legs. State is polled back so the chip reflects the engine, not the click.
//
// Selector strategy: HL's app is a React SPA with no stable ids, so we use text heuristics
// (a table row containing the coin + Long/Short) and keep re-attaching via MutationObserver.
// This only needs to survive a recording session — if the row can't be found, we fall back to a
// docked pill (bottom-right) so the demo never dies on a DOM change.

(() => {
  const COIN = "BTC";
  const POLL_MS = 3000;
  const WIDGET_ID = "atticus-protect-widget";

  // ── plumbing ────────────────────────────────────────────────────────────────
  const api = (path, method, body) =>
    new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "atticus_fetch", path, method, body }, (res) => {
          if (chrome.runtime.lastError || !res) resolve({ ok: false, error: chrome.runtime.lastError?.message || "no response" });
          else resolve(res);
        });
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    });

  // ── widget ──────────────────────────────────────────────────────────────────
  let busy = false;

  const buildWidget = () => {
    const el = document.createElement("span");
    el.id = WIDGET_ID;
    el.className = "atticus-protect";
    el.innerHTML =
      '<span class="ap-label">Protect</span>' +
      '<span class="ap-switch" role="switch" aria-checked="false" tabindex="0"><span class="ap-knob"></span></span>' +
      '<span class="ap-chip ap-idle">off</span>';
    el.querySelector(".ap-switch").addEventListener("click", onToggle);
    return el;
  };

  const widget = () => document.getElementById(WIDGET_ID);

  const setSwitch = (on) => {
    const sw = widget()?.querySelector(".ap-switch");
    if (sw) {
      sw.setAttribute("aria-checked", on ? "true" : "false");
      sw.classList.toggle("ap-on", !!on);
    }
  };

  const setChip = (text, cls) => {
    const chip = widget()?.querySelector(".ap-chip");
    if (chip) {
      chip.textContent = text;
      chip.className = "ap-chip " + (cls || "ap-idle");
    }
  };

  const onToggle = async () => {
    if (busy) return;
    const on = widget()?.querySelector(".ap-switch")?.getAttribute("aria-checked") === "true";
    if (on) {
      // Demo wraps run their tenor (or conclude via the control room) — the toggle doesn't unwind.
      setChip("wrap runs its tenor — see control room", "ap-warn");
      return;
    }
    busy = true;
    setChip("wrapping…", "ap-warn");
    const res = await api("/demo/api/wrap", "POST");
    busy = false;
    if (res.ok && res.json && res.json.ok) {
      setSwitch(true);
      const credit = res.json.wrap?.quote?.creditUsdc;
      setChip("PROTECTED" + (credit != null ? " · $" + credit + " credit" : ""), "ap-good");
    } else {
      setSwitch(false);
      setChip((res.json && (res.json.message || res.json.error)) || res.error || "demo service offline?", "ap-bad");
    }
  };

  // ── state sync (engine is the source of truth, not the click) ──────────────
  const sync = async () => {
    const res = await api("/demo/api/state", "GET");
    if (!res.ok || !res.json || !res.json.ok) {
      if (!busy) setChip("engine offline", "ap-bad");
      return;
    }
    const wraps = res.json.wraps || [];
    const w = wraps[wraps.length - 1];
    if (!w || w.status === "failed" || w.status === "concluded") {
      if (!busy) {
        setSwitch(false);
        setChip(w && w.status === "concluded" ? "concluded — fully vested" : "off", "ap-idle");
      }
      return;
    }
    if (w.status === "active" && w.vestingStatus) {
      setSwitch(true);
      const v = w.vestingStatus;
      setChip("PROTECTED · $" + v.vestedUsdc.toFixed(2) + " / $" + v.fullCreditUsdc.toFixed(2) + " vested", "ap-good");
    } else if (w.status === "quoting" || w.status === "executing") {
      setSwitch(true);
      setChip(w.status === "executing" ? "hedge legs executing…" : "pricing…", "ap-warn");
    }
  };

  // ── placement: position row first, docked pill as fallback ─────────────────
  const findPositionRow = () => {
    for (const tr of document.querySelectorAll("tbody tr")) {
      const t = tr.textContent || "";
      if (t.includes(COIN) && /\b(long|short)\b/i.test(t)) return tr;
    }
    return null;
  };

  const attach = () => {
    if (widget()) return; // already placed and still in the DOM
    const row = findPositionRow();
    const el = buildWidget();
    if (row) {
      const lastCell = row.querySelector("td:last-child") || row;
      lastCell.appendChild(el);
    } else {
      el.classList.add("ap-docked");
      document.body.appendChild(el);
    }
    sync();
  };

  // React re-renders replace rows — keep re-attaching (debounced).
  let raf = null;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      attach();
    });
  });

  const start = () => {
    attach();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(sync, POLL_MS);
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
