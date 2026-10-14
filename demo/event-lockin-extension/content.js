// Atticus Earn & Protect: Lock in (content script).
//
// Renders ONE kind of element, a "Lock in" button, beside each open position on a venue's
// positions page, and ONE sheet when it is tapped. That placement is the only staged pixel of
// the demo, and it is disclosed on the sheet. Everything behind the tap is the Atticus event
// service: the game is matched, the position is priced from live books at the holder's size,
// the terms lock, the record is written, the hedge is bought. The venue is never touched.
//
// Selector strategy: a venue's web app is a React SPA with no stable ids, so rows are found by
// text: an element that names a team the service can protect AND shows a dollar amount (a stake
// or a payout) is a position row. The smallest such element wins; nested matches collapse to the
// innermost. Re-attached on DOM changes. If no row can be read, a docked "Lock in" pill opens the
// sheet with a game picker, so the recording never dies on a layout change.
//
// Nothing here holds credentials. The lock key lives in extension storage and is attached by the
// background worker; the venue's own session is never read or used.

(() => {
  const POLL_MARKETS_MS = 5 * 60_000;
  const TIER_ORDER = ["tight", "balanced", "wide"];
  const TIER_WORDS = { tight: "Most now", balanced: "Balanced", wide: "Most upside" };
  const DEFAULTS = { defaultContracts: 20, showHedge: "no" };

  const S = {
    settings: { ...DEFAULTS },
    markets: [],
    byTicker: {},
    teamKeys: [], // [{ key, ticker }] longest first
    rows: new Map(), // ticker -> { el, contracts, entryCents, side }
    locked: new Map(), // ticker -> { floorCents, capCents, creditCents, contracts, sideName }
    open: null,
    quote: null,
    tier: null,
    contracts: null,
    entryCents: null,
    busy: false,
    how: false,
    adjust: false,
    pickerLeague: "",
  };

  // ── plumbing ────────────────────────────────────────────────────────────────
  const api = (path, method, body) =>
    new Promise((resolve) => {
      let done = false;
      const finish = (r) => {
        if (!done) {
          done = true;
          resolve(r);
        }
      };
      const deadline = setTimeout(() => finish({ ok: false, status: 0, error: "no response from the service" }), path === "/api/shadow/lock" ? 60_000 : 20_000);
      try {
        chrome.runtime.sendMessage({ type: "atticus_fetch", path, method, body }, (res) => {
          clearTimeout(deadline);
          if (chrome.runtime.lastError || !res) finish({ ok: false, status: 0, error: chrome.runtime.lastError?.message || "no response" });
          else finish(res);
        });
      } catch (e) {
        clearTimeout(deadline);
        finish({ ok: false, status: 0, error: String(e) });
      }
    });

  const loadSettings = () =>
    new Promise((resolve) => {
      try {
        chrome.storage.local.get(DEFAULTS, (v) => resolve({ ...DEFAULTS, ...(v || {}) }));
      } catch {
        resolve({ ...DEFAULTS });
      }
    });

  const usd = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const usd0 = (c) => (c % 100 === 0 ? "$" + (c / 100).toLocaleString("en-US") : usd(c));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const el = (id) => document.getElementById(id);
  const reshape = (n, F, C, K) => ({ floorTotal: F * n + K, capTotal: C * n + K });
  const fmtAt = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).toLowerCase().replace(" ", "") + " ET";
    } catch {
      return "";
    }
  };

  // ── the games the service can protect ───────────────────────────────────────
  // The service lists each side by city (Kalshi's subtitle). The venue's row may say the city, the
  // nickname, or both, so the team code at the end of the ticker is mapped to a nickname here.
  const NICK = {
    nba: { ATL: "Hawks", BOS: "Celtics", BKN: "Nets", CHA: "Hornets", CHI: "Bulls", CLE: "Cavaliers", DAL: "Mavericks", DEN: "Nuggets", DET: "Pistons", GSW: "Warriors", HOU: "Rockets", IND: "Pacers", LAC: "Clippers", LAL: "Lakers", MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks", MIN: "Timberwolves", NOP: "Pelicans", NYK: "Knicks", OKC: "Thunder", ORL: "Magic", PHI: "76ers", PHX: "Suns", POR: "Trail Blazers", SAC: "Kings", SAS: "Spurs", TOR: "Raptors", UTA: "Jazz", WAS: "Wizards" },
    nfl: { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", LA: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" },
    mlb: { ARI: "Diamondbacks", ATL: "Braves", BAL: "Orioles", BOS: "Red Sox", CHC: "Cubs", CWS: "White Sox", CHW: "White Sox", CIN: "Reds", CLE: "Guardians", COL: "Rockies", DET: "Tigers", HOU: "Astros", KC: "Royals", LAA: "Angels", LAD: "Dodgers", MIA: "Marlins", MIL: "Brewers", MIN: "Twins", NYM: "Mets", NYY: "Yankees", OAK: "Athletics", ATH: "Athletics", PHI: "Phillies", PIT: "Pirates", SD: "Padres", SF: "Giants", SEA: "Mariners", STL: "Cardinals", TB: "Rays", TEX: "Rangers", TOR: "Blue Jays", WSH: "Nationals", WAS: "Nationals" },
  };
  const nickOf = (m) => {
    const code = String(m.ticker || "").slice(String(m.ticker || "").lastIndexOf("-") + 1);
    return (NICK[String(m.league || "").toLowerCase()] || {})[code] || null;
  };

  const labelOf = (m) => {
    const city = String(m.sideName || "").trim().replace(/\s+[A-Z]$/, "");
    const nick = nickOf(m);
    return nick ? (city ? city + " " + nick : nick) : city || m.ticker;
  };

  const indexMarkets = (markets) => {
    S.markets = markets;
    S.byTicker = {};
    const keys = [];
    for (const m of markets) {
      S.byTicker[m.ticker] = m;
      const city = String(m.sideName || "").trim();
      const nick = nickOf(m);
      // a Kalshi subtitle sometimes carries a single disambiguating letter ("Los Angeles C"); drop it
      const cityClean = city.replace(/\s+[A-Z]$/, "");
      if (nick) {
        if (cityClean) keys.push({ key: (cityClean + " " + nick).toLowerCase(), ticker: m.ticker });
        keys.push({ key: nick.toLowerCase(), ticker: m.ticker });
      }
      if (cityClean) keys.push({ key: cityClean.toLowerCase(), ticker: m.ticker });
    }
    // longest key first so "Boston Celtics" beats "Boston", and a full name beats a city shared by two leagues
    keys.sort((a, b) => b.key.length - a.key.length);
    S.teamKeys = keys;
  };

  const loadMarkets = async () => {
    const r = await api("/api/shadow/markets", "GET");
    if (r.ok && r.json && r.json.ok && Array.isArray(r.json.markets)) {
      indexMarkets(r.json.markets);
      S.serviceState = "ok";
    } else {
      S.serviceState = r.status === 403 ? "key" : r.status === 404 ? "off" : "down";
    }
    placeAll();
  };

  /** The other side of the same game, when the service lists it. */
  const otherSide = (ticker) => {
    const stem = ticker.slice(0, ticker.lastIndexOf("-"));
    return S.markets.find((m) => m.ticker !== ticker && m.ticker.startsWith(stem + "-")) || null;
  };

  // ── reading a position row ───────────────────────────────────────────────────
  const MONEY = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  const AMERICAN = /(?:^|[^\d.])([+-]\d{3,4})(?![\d.])/;
  // an exchange shows the multiplier ("2.30x"): decimal odds, payout = stake x multiplier
  const MULTIPLIER = /(?:^|[^\d.])(\d{1,2}\.\d{1,3})\s?x(?![a-z])/i;

  /**
   * First team key the row names, by position in the text (the pick is the headline). Falls back
   * to the team code as its own word ("DEN · Winner"), which exchanges print beside the nickname.
   */
  const teamIn = (text) => {
    const t = text.toLowerCase();
    let best = null;
    for (const k of S.teamKeys) {
      const i = t.indexOf(k.key);
      if (i < 0) continue;
      if (!best || i < best.i || (i === best.i && k.key.length > best.len)) best = { i, len: k.key.length, ticker: k.ticker };
    }
    if (best) return { ticker: best.ticker, weak: false };
    // A code alone is a weak match: skipped when two games share it (IND is Colts and Pacers), and
    // dropped by findRows when it sits inside a row that matched by name.
    for (const m of S.markets) {
      const code = m.ticker.slice(m.ticker.lastIndexOf("-") + 1);
      if (code.length < 2 || code.length > 4 || !new RegExp("(^|[^A-Z])" + code + "(?![A-Z])").test(text)) continue;
      const stem = (t) => t.slice(0, t.lastIndexOf("-"));
      if (S.markets.some((o) => stem(o.ticker) !== stem(m.ticker) && o.ticker.endsWith("-" + code))) return null;
      return { ticker: m.ticker, weak: true };
    }
    return null;
  };

  /**
   * Size from the row's words. A stake and the odds give the payout in $1 contracts (stake x
   * decimal odds; American odds are converted) and the entry price (100 / decimal). A labelled
   * stake wins over the first dollar amount; a "payout" or "to win" amount gives the payout
   * directly. Null when unreadable.
   */
  const readSize = (text) => {
    const amounts = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(text))) amounts.push(Number(m[1].replace(/,/g, "")));
    if (!amounts.length) return null;
    const mult = MULTIPLIER.exec(text);
    // two amounts a multiplier apart are the stake and the payout, whatever the labels around them say
    if (mult && Number(mult[1]) > 1) {
      const k = Number(mult[1]);
      for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && Math.abs(b - a * k) <= Math.max(0.02, 0.01 * b)) return sizeOf(a, b);
    }
    const labelled = /(wager|stake|risk|bet|amount|cost)\D{0,12}\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(text);
    const stake = labelled ? Number(labelled[2].replace(/,/g, "")) : amounts[0];
    const toWin = /(to win|payout|returns?|win)\D{0,12}\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/i.exec(text);
    const odds = AMERICAN.exec(text);
    let payout = null;
    if (toWin) {
      const w = Number(toWin[2].replace(/,/g, ""));
      payout = /payout|returns?/i.test(toWin[1]) ? w : stake + w;
    } else if (mult && Number(mult[1]) > 1) {
      payout = stake * Number(mult[1]);
    } else if (odds) {
      const o = Number(odds[1]);
      const dec = o > 0 ? 1 + o / 100 : 1 + 100 / Math.abs(o);
      payout = stake * dec;
    }
    if (!payout || !(payout > 0) || !(stake > 0)) return null;
    return sizeOf(stake, payout);
  };

  /** $1 contracts and entry price from a stake and its payout. */
  const sizeOf = (stake, payout) => ({
    contracts: Math.max(1, Math.round(payout)),
    entryCents: Math.min(99, Math.max(1, Math.round((100 * stake) / payout))),
  });

  const OURS = (node) => node.closest && node.closest(".ael-ui");

  const findRows = () => {
    if (!S.teamKeys.length) return [];
    const found = [];
    const all = document.body.querySelectorAll("li, tr, article, [role=listitem], [role=row], div, section");
    for (const node of all) {
      if (OURS(node)) continue;
      const text = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (text.length < 12 || text.length > 420 || !text.includes("$")) continue;
      const hit = teamIn(text);
      if (!hit) continue;
      found.push({ node, ticker: hit.ticker, weak: hit.weak, text, size: readSize(text) });
    }
    // A code-only match inside or around a row that named its team is that row's cell or container,
    // not another position.
    const strong = found.filter((c) => !c.weak);
    const kept = found.filter((c) => !c.weak || !strong.some((s) => s.node.contains(c.node) || c.node.contains(s.node)));
    // Per team, the innermost candidate whose size reads is the row: a payout cell that names the
    // team ("if SF wins") is inside the row and has no stake, so the row around it wins. When no
    // candidate reads, the innermost stands and the sheet uses the default size.
    const byTicker = new Map();
    for (const c of kept) {
      const list = byTicker.get(c.ticker) || [];
      list.push(c);
      byTicker.set(c.ticker, list);
    }
    const rows = [];
    for (const list of byTicker.values()) {
      list.sort((a, b) => a.text.length - b.text.length);
      rows.push(list.find((c) => c.size) || list[0]);
    }
    return rows.slice(0, 12);
  };

  // ── placement: a button glued to each row; a docked pill when none reads ────
  const ensureButton = (ticker) => {
    let b = document.getElementById("ael-btn-" + ticker);
    if (b) return b;
    b = document.createElement("button");
    b.id = "ael-btn-" + ticker;
    b.className = "ael-ui ael-btn";
    b.type = "button";
    b.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg><span>Lock in</span>';
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSheet(ticker);
    });
    document.body.appendChild(b);
    return b;
  };

  const paintButton = (ticker) => {
    const b = ensureButton(ticker);
    const L = S.locked.get(ticker);
    if (L) {
      // short enough to stay beside the row; the tap reopens the sheet with the full terms
      b.className = "ael-ui ael-btn ael-locked";
      b.innerHTML = "<span>Locked &middot; +" + esc(usd(L.creditCents)) + " paid</span>";
      b.title = "Ends " + usd(reshape(L.contracts, L.floorCents, L.capCents, L.creditCents).floorTotal) + " or " + usd(reshape(L.contracts, L.floorCents, L.capCents, L.creditCents).capTotal);
    }
  };

  const positionButtons = () => {
    for (const [ticker, row] of S.rows) {
      const b = document.getElementById("ael-btn-" + ticker);
      if (!b) continue;
      if (!document.body.contains(row.el)) {
        b.remove();
        S.rows.delete(ticker);
        continue;
      }
      const r = row.el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > window.innerHeight) {
        b.style.display = "none";
        continue;
      }
      b.style.display = "";
      const w = b.getBoundingClientRect();
      // beside the row when the page leaves room; else in the row's bottom-right corner, where it
      // covers the least (the figures sit on the row's midline)
      const outside = r.right + 10 + w.width <= window.innerWidth - 8;
      b.style.top = Math.round(outside ? r.top + r.height / 2 - w.height / 2 : r.bottom - w.height - 6) + "px";
      b.style.left = Math.round(outside ? r.right + 10 : Math.max(8, r.right - w.width - 10)) + "px";
    }
  };

  const ensurePill = () => {
    let p = document.getElementById("ael-pill");
    if (p) return p;
    p = document.createElement("button");
    p.id = "ael-pill";
    p.className = "ael-ui ael-pill";
    p.type = "button";
    p.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg><span>Lock in</span>';
    p.addEventListener("click", () => openPicker());
    document.body.appendChild(p);
    return p;
  };

  const placeAll = () => {
    const rows = findRows();
    const seen = new Set();
    for (const c of rows) {
      seen.add(c.ticker);
      const size = c.size;
      S.rows.set(c.ticker, { el: c.node, contracts: size ? size.contracts : null, entryCents: size ? size.entryCents : null });
      paintButton(c.ticker);
    }
    for (const ticker of [...S.rows.keys()]) {
      if (!seen.has(ticker)) {
        const b = document.getElementById("ael-btn-" + ticker);
        if (b) b.remove();
        S.rows.delete(ticker);
      }
    }
    const pill = ensurePill();
    pill.style.display = rows.length ? "none" : "";
    pill.title = S.serviceState === "key" ? "Lock key missing or wrong: open the extension's settings" : S.serviceState === "off" ? "The service has no lock routes configured" : S.serviceState === "down" ? "The service is unreachable" : "";
    positionButtons();
  };

  // ── the sheet (ours, the same in any host) ───────────────────────────────────
  const ensureSheet = () => {
    if (el("ael-sheet")) return;
    const scrim = document.createElement("div");
    scrim.id = "ael-scrim";
    scrim.className = "ael-ui ael-scrim";
    scrim.addEventListener("click", closeSheet);
    const sheet = document.createElement("div");
    sheet.id = "ael-sheet";
    sheet.className = "ael-ui ael-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    // no brand of ours up top: the panel reads as the venue's own order slip; the third-party line is at the foot
    sheet.innerHTML = '<div class="ael-grab"></div><div class="ael-head"><span>Protection</span><button type="button" class="ael-x" id="ael-x" aria-label="Close">&times;</button></div><div id="ael-body"></div>';
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    el("ael-x").addEventListener("click", closeSheet);
  };

  const showSheet = (on) => {
    ensureSheet();
    el("ael-scrim").className = "ael-ui ael-scrim" + (on ? " ael-on" : "");
    el("ael-sheet").className = "ael-ui ael-sheet" + (on ? " ael-on" : "");
  };

  const closeSheet = () => {
    if (S.busy) return;
    S.open = null;
    S.quote = null;
    showSheet(false);
  };

  const sizeFor = (ticker) => {
    const row = S.rows.get(ticker);
    return {
      contracts: S.contracts || (row && row.contracts) || S.settings.defaultContracts || 20,
      entryCents: S.entryCents !== null ? S.entryCents : row && row.entryCents ? row.entryCents : null,
    };
  };

  const openSheet = (ticker, keepSize) => {
    const m = S.byTicker[ticker] || {};
    if (S.locked.has(ticker)) {
      S.open = ticker;
      paintDone(S.locked.get(ticker));
      showSheet(true);
      return;
    }
    if (!keepSize) {
      S.contracts = null;
      S.entryCents = null;
    }
    S.open = ticker;
    S.quote = null;
    S.how = false;
    S.adjust = false;
    S.tier = null;
    const size = sizeFor(ticker);
    showSheet(true);
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in this position</h2><div class="ael-who">' + esc(m.ticker ? labelOf(m) : ticker) + " &middot; " + size.contracts + ' contracts</div><div class="ael-skel"></div><div class="ael-skel" style="width:70%"></div><div class="ael-skel" style="width:40%"></div>';
    const path = "/api/shadow/quote?ticker=" + encodeURIComponent(ticker) + "&contracts=" + size.contracts + (size.entryCents ? "&entry=" + size.entryCents : "");
    api(path, "GET").then((r) => {
      if (S.open !== ticker) return;
      if (!r.ok || !r.json) return paintRefusal(ticker, r.status === 403 ? "The lock key is missing or wrong. Open the extension's settings." : r.status === 404 ? "The service has no lock routes configured." : "Live pricing is unavailable right now.");
      const p = r.json;
      if (!p.ok) return paintRefusal(ticker, p.message || "Protection isn't available on this position right now.");
      if (p.onRecord) return paintRefusal(ticker, "This market is already on the record. Pick the other side or another game.");
      S.quote = p;
      const q = p.quote;
      if (!q || !q.ok) return paintRefusal(ticker, q && q.detail ? q.detail : "Protection isn't available on this position right now.");
      S.tier = q.tiers && q.tiers.balanced ? "balanced" : q.tiers && q.tiers.tight ? "tight" : q.tiers && q.tiers.wide ? "wide" : q.tier;
      paintQuote();
    });
  };

  const sizeLine = (ticker, contracts) =>
    '<div class="ael-size">' + contracts + ' contracts <a href="#" id="ael-size-edit">edit</a><span class="ael-size-form" id="ael-size-form"><input id="ael-size-n" type="number" min="1" max="10000" step="1" value="' + contracts + '" /> <button type="button" id="ael-size-go">Reprice</button></span></div>';

  const wireSize = (ticker) => {
    const edit = el("ael-size-edit");
    if (!edit) return;
    edit.onclick = (e) => {
      e.preventDefault();
      el("ael-size-form").classList.toggle("ael-on");
      el("ael-size-n").focus();
    };
    el("ael-size-go").onclick = () => {
      const n = Math.max(1, Math.min(10000, Math.round(Number(el("ael-size-n").value) || 1)));
      S.contracts = n;
      openSheet(ticker, true);
    };
  };

  const paintRefusal = (ticker, detail) => {
    const m = S.byTicker[ticker] || {};
    const other = otherSide(ticker);
    const size = sizeFor(ticker);
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in this position</h2><div class="ael-who">' + esc(m.ticker ? labelOf(m) : ticker) + "</div>" + sizeLine(ticker, size.contracts) +
      '<div class="ael-refusal"><b>Not right now.</b> ' + esc(detail) + "</div>" +
      (other ? '<button type="button" class="ael-go ael-quiet" id="ael-other">Try the other side: ' + esc(labelOf(other)) + "</button>" : "") +
      '<button type="button" class="ael-go ael-quiet" id="ael-close">Close</button>' +
      '<div class="ael-fine">The lock is only offered when the market pays you for it.</div>' +
      '<div class="ael-disclose">Third-party protection by Atticus. Panel rendered locally for this demo; not a product of this venue.</div>';
    el("ael-close").onclick = closeSheet;
    if (other) el("ael-other").onclick = () => openSheet(other.ticker, true);
    wireSize(ticker);
  };

  const paintQuote = () => {
    const ticker = S.open;
    const p = S.quote;
    const q = p.quote;
    const offered = q.tiers || {};
    const t = offered[S.tier] || q;
    const n = q.contracts || p.contracts;
    const rs = reshape(n, t.floorCents, t.capCents, t.creditCents);
    let chips = "";
    const keys = Object.keys(offered);
    if (keys.length > 1) {
      for (const k of TIER_ORDER) {
        const tt = offered[k];
        if (!tt) continue;
        const tr = reshape(n, tt.floorCents, tt.capCents, tt.creditCents);
        chips += '<button type="button" class="ael-chip" data-tier="' + k + '" aria-pressed="' + (k === S.tier) + '"><b>' + TIER_WORDS[k] + "</b>" + esc(usd(tr.floorTotal)) + " or " + esc(usd(tr.capTotal)) + "<br>+" + esc(usd(tt.creditCents)) + " now</button>";
      }
    }
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in this position</h2><div class="ael-who">' + esc(p.sideName || "") + " &middot; " + esc(p.eventTitle || "") + (p.eventTimeIso ? " &middot; " + esc(fmtAt(p.eventTimeIso)) : "") + " &middot; " + p.markCents + "&cent; now</div>" +
      sizeLine(ticker, n) +
      '<div class="ael-tiles"><div class="ael-tile"><div class="ael-l">if it loses</div><div class="ael-v">' + esc(usd(rs.floorTotal)) + '</div><div class="ael-was">was $0</div></div>' +
      '<div class="ael-tile ael-k"><div class="ael-l">paid now</div><div class="ael-v">+' + esc(usd(t.creditCents)) + '</div><div class="ael-was">yours today</div></div>' +
      '<div class="ael-tile"><div class="ael-l">if it wins</div><div class="ael-v">' + esc(usd(rs.capTotal)) + '</div><div class="ael-was">was ' + esc(usd0(100 * n)) + "</div></div></div>" +
      (chips ? '<div class="ael-chips' + (S.adjust ? " ael-on" : "") + '" id="ael-chips">' + chips + "</div>" : "") +
      '<button type="button" class="ael-go" id="ael-go">Lock in &middot; +' + esc(usd(t.creditCents)) + " now</button>" +
      '<div class="ael-fine">priced live &middot; locks at your tap' + (chips ? ' &middot; <a href="#" id="ael-adjust">adjust</a>' : "") + ' &middot; <a href="#" id="ael-how">how it works</a></div>' +
      '<div class="ael-how' + (S.how ? " ael-on" : "") + '" id="ael-how-body"><p>You sell part of this position at today\'s price and keep the rest. That is why you are paid now.</p><p>If ' + esc(p.sideName || "your side") + " loses you end with " + esc(usd(rs.floorTotal)) + " instead of $0. If it wins, " + esc(usd(rs.capTotal)) + " instead of " + esc(usd0(100 * n)) + ".</p><p>The credit you see is the credit you get. It settles on the same official result as your position; nothing to manage.</p><p>Terms lock at your tap; the other side is bought in the same second.</p></div>" +
      '<div class="ael-disclose">Third-party protection by Atticus. Button and panel rendered locally for this demo; not a product of this venue. Pricing, record and hedge are live.</div>';
    for (const c of el("ael-body").querySelectorAll("[data-tier]")) {
      c.onclick = () => {
        S.tier = c.getAttribute("data-tier");
        S.adjust = true;
        paintQuote();
      };
    }
    if (el("ael-adjust"))
      el("ael-adjust").onclick = (e) => {
        e.preventDefault();
        S.adjust = !S.adjust;
        el("ael-chips").className = "ael-chips" + (S.adjust ? " ael-on" : "");
      };
    el("ael-how").onclick = (e) => {
      e.preventDefault();
      S.how = !S.how;
      el("ael-how-body").className = "ael-how" + (S.how ? " ael-on" : "");
    };
    el("ael-go").onclick = () => lockIn(ticker, n, t);
    wireSize(ticker);
  };

  const lockIn = async (ticker, n, t) => {
    if (S.busy) return;
    S.busy = true;
    const go = el("ael-go");
    go.disabled = true;
    const t0 = Date.now();
    go.textContent = "Locking in…";
    const tick = setInterval(() => {
      if (el("ael-go")) el("ael-go").textContent = "Locking in… " + Math.round((Date.now() - t0) / 1000) + "s";
    }, 1000);
    const size = sizeFor(ticker);
    const r = await api("/api/shadow/lock", "POST", { ticker, contracts: n, entryCents: size.entryCents || undefined, tier: S.tier || undefined });
    clearInterval(tick);
    S.busy = false;
    if (!r.ok || !r.json || !r.json.ok) {
      const msg = (r.json && (r.json.message || r.json.error)) || r.error || "The lock did not go through. Nothing changed.";
      paintRefusal(ticker, msg);
      return;
    }
    const L = { ticker, contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: r.json.creditCents, sideName: r.json.sideName, hedge: r.json.hedge || null };
    S.locked.set(ticker, L);
    paintDone(L);
    paintButton(ticker);
    positionButtons();
  };

  const paintDone = (L) => {
    const rs = reshape(L.contracts, L.floorCents, L.capCents, L.creditCents);
    const h = L.hedge;
    const hedgeLine =
      S.settings.showHedge === "yes" && h
        ? '<div class="ael-op">' +
          (h.simulated ? "hedge held: " + esc(h.fallbackReason || "simulated") : "hedged live &middot; order " + esc(h.orderId || "") + " &middot; " + (h.unitsMilli ? h.unitsMilli / 1000 : "") + " No &middot; " + (h.costCents != null ? esc(usd(h.costCents)) : "")) +
          "</div>"
        : "";
    el("ael-body").innerHTML =
      '<div class="ael-done"><div class="ael-ck">&#x2713;</div><h2 id="ael-h">Locked in</h2>' +
      '<div class="ael-sum">' + esc(L.sideName || "") + " &middot; " + L.contracts + " contracts<br>ends <b>" + esc(usd(rs.floorTotal)) + "</b> or <b>" + esc(usd(rs.capTotal)) + "</b><br><b>+" + esc(usd(L.creditCents)) + "</b> paid now</div></div>" +
      hedgeLine +
      '<button type="button" class="ael-go" id="ael-done">Done</button><div class="ael-fine">Nothing to manage. It settles with your position.</div>' +
      '<div class="ael-disclose">Third-party protection by Atticus. Panel rendered locally for this demo; not a product of this venue.</div>';
    el("ael-done").onclick = closeSheet;
  };

  // ── the picker: when no row can be read, choose the game by hand ────────────
  const openPicker = () => {
    S.open = "__picker__";
    showSheet(true);
    const leagues = [...new Set(S.markets.map((m) => m.league))];
    const league = S.pickerLeague || leagues[0] || "";
    const rows = S.markets.filter((m) => !league || m.league === league);
    let list = "";
    for (const m of rows) {
      list += '<button type="button" class="ael-pick' + (m.onRecord ? " ael-held" : "") + '" data-ticker="' + esc(m.ticker) + '"' + (m.onRecord ? " disabled" : "") + "><b>" + esc(labelOf(m)) + "</b><span>" + esc(m.title || "") + (m.dateIso ? " &middot; " + esc(m.dateIso) : "") + " &middot; " + m.markCents + "&cent;" + (m.onRecord ? " &middot; on record" : "") + (m.live ? " &middot; armed" : "") + "</span></button>";
    }
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in a position</h2><div class="ael-who">' + (S.serviceState === "ok" ? "No position row was read on this page. Pick the side you hold." : S.serviceState === "key" ? "The lock key is missing or wrong. Open the extension's settings." : S.serviceState === "off" ? "The service has no lock routes configured." : "The service is unreachable.") + "</div>" +
      (leagues.length > 1 ? '<div class="ael-leagues">' + leagues.map((l) => '<button type="button" class="ael-chip" data-league="' + esc(l) + '" aria-pressed="' + (l === league) + '"><b>' + esc(l.toUpperCase()) + "</b></button>").join("") + "</div>" : "") +
      '<div class="ael-list">' + (list || '<div class="ael-refusal">No games in the window right now.</div>') + "</div>" +
      '<button type="button" class="ael-go ael-quiet" id="ael-close">Close</button>';
    el("ael-close").onclick = closeSheet;
    for (const b of el("ael-body").querySelectorAll("[data-league]"))
      b.onclick = () => {
        S.pickerLeague = b.getAttribute("data-league");
        openPicker();
      };
    for (const b of el("ael-body").querySelectorAll("[data-ticker]")) b.onclick = () => openSheet(b.getAttribute("data-ticker"));
  };

  // ── start ───────────────────────────────────────────────────────────────────
  let raf = null;
  const observer = new MutationObserver(() => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      placeAll();
    });
  });

  const start = async () => {
    S.settings = await loadSettings();
    ensureSheet();
    ensurePill();
    await loadMarkets();
    observer.observe(document.body, { childList: true, subtree: true });
    setInterval(loadMarkets, POLL_MARKETS_MS);
    setInterval(positionButtons, 400);
    window.addEventListener("scroll", positionButtons, true);
    window.addEventListener("resize", positionButtons);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.open) closeSheet();
    });
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
})();
