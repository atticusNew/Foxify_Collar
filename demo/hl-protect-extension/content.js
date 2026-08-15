// Atticus Earn & Protect — demo toggle (content script).
//
// Renders ONE small element — an "Earn & Protect" toggle — into the live Hyperliquid positions UI, styled
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
  // Timeout guard: MV3 background workers can be killed mid-flight, losing the sendMessage
  // callback forever — without a deadline the chip freezes ("closing early…") and busy never
  // clears. Wraps legitimately take ~60s (live legs); everything else should answer in seconds.
  const API_TIMEOUT_MS = { "/demo/api/wrap": 120000 };
  const api = (path, method, body) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (res) => { if (!done) { done = true; resolve(res); } };
      const deadline = setTimeout(
        () => finish({ ok: false, error: "no response from the demo service — refresh the page and check the control room" }),
        API_TIMEOUT_MS[path] || 15000
      );
      try {
        chrome.runtime.sendMessage({ type: "atticus_fetch", path, method, body }, (res) => {
          clearTimeout(deadline);
          if (chrome.runtime.lastError || !res) finish({ ok: false, error: chrome.runtime.lastError?.message || "no response" });
          else finish(res);
        });
      } catch (e) {
        clearTimeout(deadline);
        finish({ ok: false, error: String(e) });
      }
    });

  // ── widget ──────────────────────────────────────────────────────────────────
  let busy = false;

  const buildWidget = () => {
    const el = document.createElement("span");
    el.id = WIDGET_ID;
    el.className = "atticus-protect";
    el.innerHTML =
      '<span class="ap-label">Earn &amp; Protect</span>' +
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
      // Toggle OFF = voluntary early close: collect the credit vested so far, claw back the rest.
      busy = true;
      setChip("closing early…", "ap-warn");
      const res = await api("/demo/api/close", "POST");
      busy = false;
      if (res.ok && res.json && res.json.ok) {
        setSwitch(false);
        const v = res.json.vested;
        setChip("closed early · kept $" + v.vestedUsdc.toFixed(2) + " of $" + v.fullCreditUsdc.toFixed(2), "ap-idle");
      } else {
        setChip((res.json && (res.json.message || res.json.error)) || res.error || "close failed", "ap-bad");
      }
      return;
    }
    busy = true;
    // Immediate knob feedback: flip ON for the attempt (flips back on refuse). Without this the
    // knob only ever moves on success, which reads as "the toggle doesn't toggle" during refusals.
    setSwitch(true);
    // The ~20s is REAL work — show it counting. One writer only: sync() stays out while busy.
    const t0 = Date.now();
    setChip("Wrapping…", "ap-warn");
    const tick = setInterval(() => setChip("Wrapping… " + Math.round((Date.now() - t0) / 1000) + "s", "ap-warn"), 1000);
    const res = await api("/demo/api/wrap", "POST");
    clearInterval(tick);
    busy = false;
    if (res.ok && res.json && res.json.ok) {
      setSwitch(true);
      const credit = res.json.wrap?.quote?.creditUsdc;
      setChip("EARNING" + (credit != null ? " · $" + credit + " credit" : ""), "ap-good");
    } else {
      setSwitch(false);
      setChip((res.json && (res.json.message || res.json.error)) || res.error || "demo service offline?", "ap-bad");
    }
  };

  // ── state sync (engine is the source of truth, not the click) ──────────────
  const sync = async () => {
    if (busy) return; // the in-flight wrap owns the chip (its counter) — no competing writers
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
        if (w && w.status === "concluded" && w.vestingStatus) {
          setChip(
            w.vestingStatus.fullyVested
              ? "completed — earned $" + w.vestingStatus.fullCreditUsdc.toFixed(2) + " in full"
              : "closed early · kept $" + w.vestingStatus.vestedUsdc.toFixed(2) + " of $" + w.vestingStatus.fullCreditUsdc.toFixed(2),
            "ap-idle"
          );
        } else if (w && w.status === "failed" && w.failReason) {
          // The refusal stays readable until the next action — the poll must not blank it to "off".
          setChip(w.failReason, "ap-bad");
        } else setChip("off", "ap-idle");
      }
      return;
    }
    if (w.status === "active" && w.vestingStatus) {
      setSwitch(true);
      const v = w.vestingStatus;
      setChip("EARNING · $" + v.vestedUsdc.toFixed(2) + " of $" + v.fullCreditUsdc.toFixed(2), "ap-good");
      // Terms on hover — the floor is real, just not clutter: tooltip carries floor/cap/tenor.
      const q = w.quote;
      if (q) {
        const hrs = Math.floor(v.remainingMs / 3600000), mins = Math.round((v.remainingMs % 3600000) / 60000);
        widget().title =
          "Floor $" + q.putStrike + " (−" + (q.floorPct * 100).toFixed(1) + "%) · Cap $" + q.callStrike + " (+" + (q.capPct * 100).toFixed(1) + "%)" +
          " · $" + q.creditUsdc + " credit · " + (v.fullyVested ? "fully vested" : hrs + "h " + mins + "m to full vest");
      }
    } else if (w.status === "quoting" || w.status === "executing") {
      // A wrap in flight from ANOTHER surface (e.g. the control-room button) — steady label, no counter.
      setSwitch(true);
      setChip("Wrapping…", "ap-warn");
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

  // The widget NEVER lives inside HL's table (fixed-width cells ⟹ overflow/misalignment). It is a
  // fixed-position overlay glued to the position row: vertically centered on the row, pinned to its
  // right edge, re-positioned continuously so scroll/resize/re-render can't detach it. No row ⟹
  // docked pill bottom-right.
  const positionOverlay = () => {
    const el = widget();
    if (!el) return;
    const row = findPositionRow();
    if (!row) {
      if (!el.classList.contains("ap-docked")) {
        el.classList.remove("ap-row-overlay");
        el.classList.add("ap-docked");
        el.style.top = "";
        el.style.left = "";
      }
      return;
    }
    if (el.classList.contains("ap-docked")) {
      el.classList.remove("ap-docked");
      el.classList.add("ap-row-overlay");
    }
    const r = row.getBoundingClientRect();
    const w = el.getBoundingClientRect();
    // Hang just BELOW the row, right-aligned: the empty strip beside "Unified Account Summary" —
    // covers no row controls (Close All / TP/SL) and never reaches the venue footer.
    const top = Math.min(r.bottom + 4, window.innerHeight - w.height - 48);
    el.style.top = Math.round(top) + "px";
    el.style.left = Math.round(Math.max(8, r.right - w.width - 10)) + "px";
  };

  const attach = () => {
    if (widget()) return;
    const el = buildWidget();
    el.classList.add("ap-docked"); // positionOverlay promotes it to the row overlay when the row exists
    document.body.appendChild(el);
    sync();
    positionOverlay();
  };

  // React re-renders replace rows — keep re-attaching (debounced) and keep the overlay glued.
  let raf = null;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      attach();
      positionOverlay();
    });
  });

  const start = () => {
    attach();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(sync, POLL_MS);
    setInterval(positionOverlay, 400);
    window.addEventListener("scroll", positionOverlay, true); // capture: HL scrolls inner containers
    window.addEventListener("resize", positionOverlay);
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
