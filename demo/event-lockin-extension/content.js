// Atticus Earn & Protect: Lock in (content script).
//
// One place, after the trade. On the venue's portfolio page, each open position the engine can
// protect gets one line directly under its row: "Lock in · +$0.60 now" with the worst case it
// buys. Tap it and our panel opens inline under that row, pushing the rows below down; nothing
// floats over the venue's page. Positions we cannot protect get the same line muted, and the tap
// says why. A locked position shows a Protected chip whose details are the four things a holder
// needs: worst case, best case, what was paid, when it settles, and the public record.
//
// Nothing is drawn on the game list, the game page or the order slip. The venue's own flow places
// the trade; protection is offered on what the account then holds.
//
// Sizes: when the service has a read-only key for the holder's venue account, every number comes
// from the service's confirmation of the position (GET /api/shadow/positions): contracts, what
// they cost, the game. Without it, the row's text is read (wager and payout) and the panel says the
// size was read from the page.
//
// Selector strategy: the venue's web app is a React SPA with no stable ids, so rows are found by
// text: a block that names a team the service can protect and carries the position's money.
// Our line is inserted as a sibling after that block and re-inserted if the venue re-renders.
// Nothing of the venue's is modified or removed. Nothing here holds credentials: the lock key
// lives in extension storage and is attached by the background worker.

(() => {
  const POLL_MARKETS_MS = 5 * 60_000;
  const POLL_POSITIONS_MS = 15_000;
  const POLL_RECORD_MS = 60_000;
  const REQUOTE_MS = 60_000;
  const SCAN_MIN_GAP_MS = 500;
  // the three shapes the service prices, shown only when the book offers more than one
  const TIER_ORDER = ["tight", "balanced", "wide"];
  const TIER_WORDS = { tight: "Most now", balanced: "Even", wide: "Keep more upside" };
  const DEFAULTS = { showHedge: "no" };
  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>';
  const SHIELD_FILL = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5" stroke="#0b0b0e" stroke-width="2.4" fill="none"/></svg>';

  const S = {
    settings: { ...DEFAULTS },
    baseUrl: "",
    markets: [],
    byTicker: {},
    nicks: new Map(), // nickname (lower) -> [{ ticker, league, code }]
    nickRe: null,
    svc: { configured: false, positions: [], at: 0, error: null },
    record: new Map(), // ticker -> the public record's lock position (open or settled)
    rows: new Map(), // row element -> binding { row, host, ticker, size, kind, from }
    st: new Map(), // ticker -> { quote, quoteAt, quoteKey, tier, open, how, busy, done }
    pageOk: false,
    serviceState: "loading",
    lastScan: 0,
    cardRows: new Map(), // position id -> binding (fallback card)
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
        chrome.storage.local.get({ ...DEFAULTS, baseUrl: "" }, (v) => resolve({ ...DEFAULTS, ...(v || {}) }));
      } catch {
        resolve({ ...DEFAULTS });
      }
    });

  const usd = (c) => (c / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
  const usd0 = (c) => (c % 100 === 0 ? "$" + (c / 100).toLocaleString("en-US") : usd(c));
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const reshape = (n, F, C, K) => ({ floorTotal: F * n + K, capTotal: C * n + K });
  const fmtAt = (iso) => {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }) + " " + d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).toLowerCase().replace(" ", "") + " ET";
    } catch {
      return "";
    }
  };
  const OURS = (node) => {
    const e = node && node.nodeType === 3 ? node.parentElement : node;
    return Boolean(e && e.closest && e.closest(".ael-ui"));
  };

  // ── the games the service can protect ───────────────────────────────────────
  // The service lists each side by city (Kalshi's subtitle). The venue prints "IND Colts", so the
  // team code at the end of the ticker is mapped to a nickname here.
  const NICK = {
    nba: { ATL: "Hawks", BOS: "Celtics", BKN: "Nets", CHA: "Hornets", CHI: "Bulls", CLE: "Cavaliers", DAL: "Mavericks", DEN: "Nuggets", DET: "Pistons", GSW: "Warriors", GS: "Warriors", HOU: "Rockets", IND: "Pacers", LAC: "Clippers", LAL: "Lakers", MEM: "Grizzlies", MIA: "Heat", MIL: "Bucks", MIN: "Timberwolves", NOP: "Pelicans", NO: "Pelicans", NYK: "Knicks", NY: "Knicks", OKC: "Thunder", ORL: "Magic", PHI: "76ers", PHX: "Suns", POR: "Trail Blazers", SAC: "Kings", SAS: "Spurs", SA: "Spurs", TOR: "Raptors", UTA: "Jazz", WAS: "Wizards" },
    nfl: { ARI: "Cardinals", ATL: "Falcons", BAL: "Ravens", BUF: "Bills", CAR: "Panthers", CHI: "Bears", CIN: "Bengals", CLE: "Browns", DAL: "Cowboys", DEN: "Broncos", DET: "Lions", GB: "Packers", HOU: "Texans", IND: "Colts", JAX: "Jaguars", JAC: "Jaguars", KC: "Chiefs", LV: "Raiders", LAC: "Chargers", LAR: "Rams", LA: "Rams", MIA: "Dolphins", MIN: "Vikings", NE: "Patriots", NO: "Saints", NYG: "Giants", NYJ: "Jets", PHI: "Eagles", PIT: "Steelers", SF: "49ers", SEA: "Seahawks", TB: "Buccaneers", TEN: "Titans", WAS: "Commanders" },
    mlb: { ARI: "Diamondbacks", ATL: "Braves", BAL: "Orioles", BOS: "Red Sox", CHC: "Cubs", CWS: "White Sox", CHW: "White Sox", CIN: "Reds", CLE: "Guardians", COL: "Rockies", DET: "Tigers", HOU: "Astros", KC: "Royals", LAA: "Angels", LAD: "Dodgers", MIA: "Marlins", MIL: "Brewers", MIN: "Twins", NYM: "Mets", NYY: "Yankees", OAK: "Athletics", ATH: "Athletics", PHI: "Phillies", PIT: "Pirates", SD: "Padres", SF: "Giants", SEA: "Mariners", STL: "Cardinals", TB: "Rays", TEX: "Rangers", TOR: "Blue Jays", WSH: "Nationals", WAS: "Nationals" },
  };
  const CODE_ALIAS = { LA: ["LAR", "LAC"], LAR: ["LA"], LAC: ["LA"], JAX: ["JAC"], JAC: ["JAX"], WSH: ["WAS"], WAS: ["WSH"], CHW: ["CWS"], CWS: ["CHW"], ATH: ["OAK"], OAK: ["ATH"], GS: ["GSW"], GSW: ["GS"], NY: ["NYK"], NYK: ["NY"], SA: ["SAS"], SAS: ["SA"], NO: ["NOP"], NOP: ["NO"] };
  const codeOf = (ticker) => String(ticker || "").slice(String(ticker || "").lastIndexOf("-") + 1);
  const nickOf = (m) => (NICK[String(m.league || "").toLowerCase()] || {})[codeOf(m.ticker)] || null;
  const labelOf = (m) => {
    const city = String(m.sideName || "").trim().replace(/\s+[A-Z]$/, "");
    const nick = nickOf(m);
    return nick ? (city ? city + " " + nick : nick) : city || m.ticker;
  };
  const shortOf = (ticker) => {
    const m = S.byTicker[ticker];
    return (m && nickOf(m)) || ticker;
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const indexMarkets = (markets) => {
    S.markets = markets;
    S.byTicker = {};
    S.nicks = new Map();
    for (const m of markets) {
      S.byTicker[m.ticker] = m;
      const nick = nickOf(m);
      if (!nick) continue;
      const k = nick.toLowerCase();
      const list = S.nicks.get(k) || [];
      list.push({ ticker: m.ticker, league: m.league, code: codeOf(m.ticker) });
      S.nicks.set(k, list);
    }
    const keys = [...S.nicks.keys()].sort((a, b) => b.length - a.length).map(escapeRe);
    S.nickRe = keys.length ? new RegExp("(^|[^a-z0-9])(" + keys.join("|") + ")(?![a-z0-9])", "ig") : null;
  };

  const loadMarkets = async () => {
    const r = await api("/api/shadow/markets", "GET");
    if (r.ok && r.json && r.json.ok && Array.isArray(r.json.markets)) {
      indexMarkets(r.json.markets);
      S.serviceState = "ok";
    } else {
      S.serviceState = r.status === 403 ? "key" : r.status === 404 ? "off" : "down";
    }
    scan(true);
  };

  /** The service's confirmation of what the account holds, when it has a read key. */
  const loadPositions = async () => {
    const r = await api("/api/shadow/positions", "GET");
    if (r.ok && r.json && r.json.ok) {
      S.svc = { configured: Boolean(r.json.configured), positions: Array.isArray(r.json.positions) ? r.json.positions : [], at: Date.now(), error: null };
      for (const p of S.svc.positions) if (p.ticker && p.lock) S.record.set(p.ticker, { ...p.lock, ticker: p.ticker, fromSvc: true });
    } else if (r.ok && r.json && r.json.configured) {
      S.svc = { ...S.svc, configured: true, error: r.json.message || "venue read failed" };
    }
    scan(true);
  };

  /** The public record: the holder's locks and how they settled, keyed by market. */
  const loadRecord = async () => {
    const r = await api("/api/shadow", "GET");
    if (!(r.ok && r.json && r.json.ok)) return;
    for (const list of [r.json.open, r.json.settled, r.json.closed]) {
      if (!Array.isArray(list)) continue;
      for (const p of list) if (p && p.source === "lock" && p.ticker) S.record.set(p.ticker, { ...p, justNow: Boolean((S.record.get(p.ticker) || {}).justNow) });
    }
    scan(true);
  };

  /** Every side the text names, with how often; the pick is named more than once on most rows. */
  const sidesIn = (text) => {
    const out = new Map();
    if (!S.nickRe) return out;
    S.nickRe.lastIndex = 0;
    let m;
    while ((m = S.nickRe.exec(text))) {
      const list = S.nicks.get(m[2].toLowerCase()) || [];
      let ticker = null;
      if (list.length === 1) ticker = list[0].ticker;
      else {
        const before = text.slice(0, m.index + m[1].length).trim();
        const code = /(?:^|[^A-Za-z])([A-Z]{2,3})$/.exec(before);
        if (code) {
          const hit = list.filter((x) => x.code === code[1] || (CODE_ALIAS[code[1]] || []).includes(x.code));
          if (hit.length === 1) ticker = hit[0].ticker;
        }
      }
      if (ticker) out.set(ticker, (out.get(ticker) || 0) + 1);
    }
    return out;
  };

  // ── reading sizes off a row (fallback when the service has no read key) ─────
  const MONEY = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  const MULTIPLIER = /(?:^|[^\d.])(\d{1,2}\.\d{1,3})\s?x(?![a-z])/i;
  const amountsIn = (text) => {
    const out = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(text))) out.push(Number(m[1].replace(/,/g, "")));
    return out;
  };
  const sizeOf = (stake, payout) => ({
    contracts: Math.max(1, Math.round(payout)),
    entryCents: Math.min(99, Math.max(1, Math.round((100 * stake) / payout))),
    stakeCents: Math.round(stake * 100),
    payoutCents: Math.round(payout * 100),
  });
  const labelled = (text, re) => {
    const m = re.exec(text);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  };
  /** Wager and payout from a row's text: labelled amounts first, then two amounts a multiplier apart. */
  const sizeIn = (text) => {
    const stake = labelled(text, /(?:wager|stake|risk|cost|bet)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const payout = labelled(text, /(?:payout|pays|returns|max\s*payout|total\s*return)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const toWin = labelled(text, /(?:to\s*win|profit|win)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    if (stake && payout && payout > stake) return sizeOf(stake, payout);
    if (stake && toWin) return sizeOf(stake, stake + toWin);
    const mult = MULTIPLIER.exec(text);
    if (mult && Number(mult[1]) > 1) {
      const k = Number(mult[1]);
      const amounts = amountsIn(text);
      for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && Math.abs(b - a * k) <= Math.max(0.02, 0.01 * b)) return sizeOf(a, b);
      if (stake) return sizeOf(stake, stake * k);
    }
    return null;
  };
  const kindIn = (text) => {
    if (/\b(spread|handicap|total|over|under|o\/u)\b/i.test(text) || /(^|\s)[+-]\d+(\.5)?(\s|$)/.test(text.replace(/\$\s?[\d,.]+/g, ""))) return /\b(winner|moneyline|money line|ml)\b/i.test(text) ? "winner" : "other";
    return "winner";
  };

  // ── finding the portfolio page and its rows ─────────────────────────────────
  const onPortfolioPage = () => {
    const where = (location.pathname + " " + location.hash).toLowerCase();
    if (/portfolio|position|my-?bets|mybets|wagers|open-?bets|activity/.test(where)) return true;
    for (const h of document.querySelectorAll("h1, h2, h3, [role=heading]")) {
      if (OURS(h)) continue;
      if (/^(portfolio|positions|open positions|my bets|open bets|my wagers|active)\b/i.test(norm(h.textContent))) return true;
    }
    return false;
  };

  const textNodes = () => {
    const out = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA" || tag === "INPUT") return NodeFilter.FILTER_REJECT;
        if (p.closest(".ael-ui")) return NodeFilter.FILTER_REJECT;
        const t = n.nodeValue;
        if (!t || t.length < 3 || t.length > 80 || !/[A-Za-z]/.test(t)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  };

  /**
   * The block that is one position: climbing from a team's text, the first ancestor whose text
   * carries the position's money (two dollar amounts, or one with a wager/payout word), of a
   * row's proportions, with no input in it (that is the order slip) and not the whole page.
   */
  const rowFrom = (node) => {
    let e = node.parentElement;
    for (let i = 0; e && e !== document.body && i < 9; i++, e = e.parentElement) {
      if (e.querySelector("input, textarea")) return null;
      const text = norm(e.textContent);
      if (text.length > 600) return null;
      const amounts = amountsIn(text);
      const moneyWords = /\b(wager|stake|payout|to win|pays|returns|cost|avg|average|contracts|shares|risk)\b/i.test(text);
      if (amounts.length >= 2 || (amounts.length >= 1 && moneyWords)) {
        const r = e.getBoundingClientRect();
        if (r.width >= 200 && r.height >= 24 && r.height <= 320 && r.width <= window.innerWidth) return e;
      }
    }
    return null;
  };

  /** The service's confirmed position for one of our markets, when it has one. */
  const svcFor = (ticker) => S.svc.positions.find((p) => p.ticker === ticker) || null;

  const findRows = (nodes) => {
    const seen = new Map(); // row element -> { tickers Map, nodes }
    for (const node of nodes) {
      const sides = sidesIn(node.nodeValue);
      if (!sides.size) continue;
      const row = rowFrom(node);
      if (!row) continue;
      const cur = seen.get(row) || { count: new Map(), first: node };
      for (const [t, n] of sides) cur.count.set(t, (cur.count.get(t) || 0) + n);
      seen.set(row, cur);
    }
    // drop any row that contains another candidate row (keep the inner one)
    const rows = [...seen.keys()].filter((r) => ![...seen.keys()].some((o) => o !== r && r.contains(o)));
    const out = [];
    for (const row of rows) {
      const text = norm(row.textContent);
      const count = new Map(sidesIn(text));
      if (!count.size) continue;
      // the pick: a "Team · Winner" style line, else the side named more than once (matchup plus
      // selection), else the one side the service confirms a position on, else the only side
      let ticker = null;
      const pick = /([A-Z]{2,3}\s+[A-Za-z0-9 .]+?)(?:\s+[+-]?\d+(?:\.\d)?)?\s*(?:[·•|]|to win)\s*(?:Winner|Moneyline|Money Line|ML|Spread|Total|Over|Under)\b/i.exec(text);
      if (pick) {
        const s = sidesIn(pick[1]);
        if (s.size === 1) ticker = [...s.keys()][0];
      }
      if (!ticker) {
        const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
        if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) ticker = sorted[0][0];
      }
      if (!ticker) {
        const withSvc = [...count.keys()].filter((t) => svcFor(t));
        if (withSvc.length === 1) ticker = withSvc[0];
      }
      if (!ticker) continue;
      // a spread or total row is never sized from the winner position the service holds on the same club
      const kind = kindIn(text);
      const svc = kind === "winner" ? svcFor(ticker) : null;
      const read = sizeIn(text);
      out.push({ row, ticker, kind, size: svc ? { contracts: svc.contracts, entryCents: svc.entryCents, stakeCents: svc.costCents, payoutCents: svc.payoutCents } : read, from: svc ? "service" : read ? "page" : "none" });
    }
    return out;
  };

  // ── our line and panel under a row ──────────────────────────────────────────
  const stateOf = (ticker) => {
    let st = S.st.get(ticker);
    if (!st) {
      st = { quote: null, quoteAt: 0, quoteKey: "", tier: null, open: false, how: false, busy: false, done: null, pending: false };
      S.st.set(ticker, st);
    }
    return st;
  };

  /** Insert after the row, climbing out of flex/grid rows so our block lands under it, not beside it. */
  const insertionPoint = (row) => {
    let target = row;
    for (let i = 0; i < 3 && target.parentElement && target.parentElement !== document.body; i++) {
      const cs = getComputedStyle(target.parentElement);
      const horizontal = (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) || cs.display.includes("grid") || cs.display.includes("inline");
      if (!horizontal) break;
      target = target.parentElement;
    }
    return target;
  };

  const mountHost = (B) => {
    const after = insertionPoint(B.row);
    let host;
    if (after.tagName === "TR") {
      host = document.createElement("tr");
      host.className = "ael-ui ael-host";
      const td = document.createElement("td");
      td.colSpan = 99;
      td.innerHTML = '<div class="ael-ui ael-row"></div>';
      host.appendChild(td);
      B.box = td.firstElementChild;
    } else {
      host = document.createElement("div");
      host.className = "ael-ui ael-host";
      host.innerHTML = '<div class="ael-ui ael-row"></div>';
      B.box = host.firstElementChild;
    }
    host.addEventListener("click", (e) => e.stopPropagation());
    after.insertAdjacentElement("afterend", host);
    B.host = host;
    B.after = after;
    fitHost(B);
  };

  /** Our block spans the row's own width and left edge. */
  const fitHost = (B) => {
    if (B.card || !B.host || !B.row.isConnected) return;
    const rr = B.row.getBoundingClientRect();
    const hr = B.box.getBoundingClientRect();
    if (!rr.width) return;
    const ml = parseFloat(B.box.style.marginLeft || "0") + (rr.left - hr.left);
    B.box.style.marginLeft = Math.round(ml) + "px";
    B.box.style.width = Math.round(rr.width) + "px";
  };

  /** The quote at this row's size, refreshed while the page is open; the lock reprices at the tap. */
  const quoteRow = (B) => {
    const st = stateOf(B.ticker);
    if (!B.size || st.done || S.record.has(B.ticker)) return;
    const key = B.ticker + ":" + B.size.contracts + ":" + (B.size.entryCents || "");
    if (st.pending) return;
    if (st.quoteKey === key && Date.now() - st.quoteAt < REQUOTE_MS) return;
    st.pending = true;
    const path = "/api/shadow/quote?ticker=" + encodeURIComponent(B.ticker) + "&contracts=" + B.size.contracts + (B.size.entryCents ? "&entry=" + B.size.entryCents : "");
    api(path, "GET").then((r) => {
      st.pending = false;
      st.quoteAt = Date.now();
      st.quoteKey = key;
      if (!r.ok || !r.json) st.quote = { ok: false, code: r.status === 403 ? "key" : r.status === 404 ? "off" : "down", message: r.status === 403 ? "The lock key is missing or wrong. Open the extension's settings." : r.status === 404 ? "The service has no lock routes configured." : "Live pricing is unavailable right now." };
      else if (!r.json.ok) st.quote = { ok: false, code: r.json.code || "unavailable", message: r.json.message || "" };
      else if (r.json.onRecord && !S.record.has(B.ticker)) st.quote = { ok: false, code: "already_on_record", message: "This market is already locked." };
      else {
        const q = r.json.quote;
        if (!q || !q.ok) st.quote = { ok: false, code: (q && q.code) || "unavailable", message: (q && q.detail) || "" };
        else {
          st.quote = { ok: true, p: r.json };
          if (!st.tier || !(q.tiers && q.tiers[st.tier])) st.tier = q.tiers && q.tiers.balanced ? "balanced" : q.tier;
        }
      }
      paintRow(B);
    });
  };

  /** Plain words for a refusal, and what to do about it. */
  const refusalWords = (code, message) => {
    switch (code) {
      case "credit_too_small":
      case "credit_nonpositive":
        return { why: "The credit at this size is under our minimum.", next: "Protection on this pick starts at a larger position. Check back closer to kickoff; the price moves." };
      case "too_expensive":
      case "protection_too_rich":
        return { why: "Protecting this pick costs more than we will pay at the current price.", next: "Check back later; the book moves toward kickoff." };
      case "not_offered":
      case "no_matched_market":
      case "league_not_covered":
      case "no_protectable_market":
        return { why: "No hedge book for this game yet.", next: "Protection reaches more games as venues are added." };
      case "market_not_covered":
      case "spread":
        return { why: "Protection covers the Winner market.", next: "A Winner pick on this game can be locked in." };
      case "market_too_close_to_start":
      case "market_not_active":
        return { why: "This game starts too soon to protect.", next: "Protection is available until shortly before kickoff." };
      case "already_on_record":
        return { why: "This market is already locked.", next: "One lock per market." };
      case "key":
        return { why: "The lock key is missing or wrong.", next: "Open the extension's settings." };
      case "off":
        return { why: "The service has no lock routes configured.", next: "" };
      case "down":
        return { why: "The service is unreachable.", next: "Try again in a moment." };
      case "no_size":
        return { why: "The size of this position could not be read.", next: "Enter it below to price protection." };
      default:
        return { why: message || "Protection isn't available on this position right now.", next: "" };
    }
    positionOverlays();
  };

  const lineGo = (label, sub, cls) => '<button type="button" class="ael-line ' + (cls || "") + '"><span class="ael-ic">' + (cls === "ael-line-on" ? SHIELD_FILL : SHIELD) + '</span><span class="ael-lt"><b>' + label + "</b>" + (sub ? "<span>" + sub + "</span>" : "") + "</span></button>";

  /** The line under the row, from the row's state. */
  const paintRow = (B) => {
    if (!B.box) return;
    const st = stateOf(B.ticker);
    // a lock on this market covers the Winner position; a spread or total row on the same club is not it
    const rec = B.kind === "winner" ? S.record.get(B.ticker) || st.done : null;
    let line;
    if (rec) {
      const rs = reshape(rec.contracts, rec.floorCents, rec.capCents, rec.creditCents);
      if (rec.status === "settled" && rec.result) line = lineGo("Settled &middot; paid " + esc(usd(rec.protectedCents != null ? rec.protectedCents : rec.result === "yes" ? rs.capTotal : rs.floorTotal)), "", "ael-line-on");
      else if (rec.status === "void") line = lineGo("Protection voided", "no official result; nothing owed", "ael-line-on");
      else line = lineGo("Protected &middot; +" + esc(usd(rec.creditCents)) + " paid", "ends " + esc(usd(rs.floorTotal)) + " or " + esc(usd(rs.capTotal)) + " &middot; details", "ael-line-on");
    } else if (B.kind === "other") {
      line = lineGo("Protection unavailable", "covers Winner picks", "ael-line-off");
    } else if (!B.size) {
      line = lineGo("Lock in", "size not read from the page", "");
    } else if (!st.quote) {
      line = lineGo("Checking protection&hellip;", "", "ael-line-wait");
    } else if (!st.quote.ok) {
      line = lineGo("Protection unavailable", esc(refusalWords(st.quote.code, st.quote.message).why.replace(/\.$/, "")), "ael-line-off");
    } else {
      const p = st.quote.p;
      const q = p.quote;
      const t = (q.tiers && q.tiers[st.tier]) || q;
      const n = q.contracts || p.contracts;
      const rs = reshape(n, t.floorCents, t.capCents, t.creditCents);
      line = lineGo("Lock in &middot; +" + esc(usd(t.creditCents)) + " now", "worst case " + esc(usd(rs.floorTotal)) + " instead of $0 &middot; best case " + esc(usd(rs.capTotal)), "");
    }
    B.box.innerHTML = line + '<div class="ael-panel' + (st.open ? " ael-on" : "") + '"></div>';
    B.box.querySelector(".ael-line").onclick = () => {
      st.open = !st.open;
      if (!st.open) st.how = false;
      paintRow(B);
    };
    if (st.open) paintPanel(B);
    fitHost(B);
  };

  const DISCLOSE = '<div class="ael-disclose">Third-party protection by Atticus, rendered here for this demo; not a product of this venue. Pricing, record and hedge are live.</div>';

  const whoLine = (B, p) => {
    const nick = shortOf(B.ticker);
    const size = B.size;
    const pays = size ? usd(size.payoutCents || size.contracts * 100) : p ? usd0(100 * p.contracts) : "";
    const paid = size && size.stakeCents ? " &middot; you paid " + esc(usd(size.stakeCents)) : "";
    const from = B.from === "page" ? " &middot; read from the page" : "";
    return esc(nick) + (pays ? " &middot; pays " + esc(pays) + " if they win" : "") + paid + from;
  };

  const paintPanel = (B) => {
    const st = stateOf(B.ticker);
    const panel = B.box.querySelector(".ael-panel");
    const rec = B.kind === "winner" ? S.record.get(B.ticker) || st.done : null;
    if (rec) return paintDetails(B, panel, rec);
    if (B.kind === "other") return paintRefusal(B, panel, "spread", "");
    if (!B.size) return paintRefusal(B, panel, "no_size", "");
    if (!st.quote) {
      panel.innerHTML = '<div class="ael-skel"></div><div class="ael-skel" style="width:70%"></div>';
      return;
    }
    if (!st.quote.ok) return paintRefusal(B, panel, st.quote.code, st.quote.message);
    const p = st.quote.p;
    const q = p.quote;
    const offered = q.tiers || {};
    const t = offered[st.tier] || q;
    const n = q.contracts || p.contracts;
    const rs = reshape(n, t.floorCents, t.capCents, t.creditCents);
    // what the position pays unprotected: the venue's figure when we have it, else the contracts
    const was = usd(B.size && B.size.payoutCents ? B.size.payoutCents : 100 * n);
    let seg = "";
    const keys = TIER_ORDER.filter((k) => offered[k]);
    if (keys.length > 1) {
      for (const k of keys) {
        const tt = offered[k];
        const tr = reshape(n, tt.floorCents, tt.capCents, tt.creditCents);
        seg += '<button type="button" class="ael-seg" data-tier="' + k + '" aria-pressed="' + (k === st.tier) + '"><b>' + TIER_WORDS[k] + "</b><span>" + esc(usd(tr.floorTotal)) + " or " + esc(usd(tr.capTotal)) + " &middot; +" + esc(usd(tt.creditCents)) + "</span></button>";
      }
    }
    panel.innerHTML =
      '<div class="ael-ph"><b>Worst case ' + esc(usd(rs.floorTotal)) + " instead of $0</b><span>" + whoLine(B, p) + "</span></div>" +
      '<div class="ael-tiles"><div class="ael-tile"><div class="ael-l">if ' + esc(shortOf(B.ticker)) + ' lose</div><div class="ael-v">' + esc(usd(rs.floorTotal)) + '</div><div class="ael-was">was $0</div></div>' +
      '<div class="ael-tile ael-k"><div class="ael-l">paid now</div><div class="ael-v">+' + esc(usd(t.creditCents)) + '</div><div class="ael-was">yours today</div></div>' +
      '<div class="ael-tile"><div class="ael-l">if they win</div><div class="ael-v">' + esc(usd(rs.capTotal)) + '</div><div class="ael-was">was ' + esc(was) + "</div></div></div>" +
      (seg ? '<div class="ael-segs">' + seg + "</div>" : "") +
      '<button type="button" class="ael-go" id="ael-go-' + esc(B.ticker) + '">Lock in &middot; +' + esc(usd(t.creditCents)) + " now</button>" +
      '<div class="ael-fine">priced live, locks at your tap' + (p.eventTimeIso ? " &middot; available until kickoff " + esc(fmtAt(p.eventTimeIso)) : "") + ' &middot; <a href="#" class="ael-how-a">how it works</a></div>' +
      '<div class="ael-how' + (st.how ? " ael-on" : "") + '"><p>You sell part of this position at today\'s price and keep the rest. That is why you are paid now.</p><p>If ' + esc(shortOf(B.ticker)) + " lose you end with " + esc(usd(rs.floorTotal)) + " instead of $0. If they win, " + esc(usd(rs.capTotal)) + " instead of " + esc(was) + ".</p><p>It settles on the same official result as your position; nothing to manage. The other side is bought the second you tap.</p></div>" +
      DISCLOSE;
    for (const c of panel.querySelectorAll("[data-tier]"))
      c.onclick = () => {
        st.tier = c.getAttribute("data-tier");
        paintRow(B);
      };
    panel.querySelector(".ael-how-a").onclick = (e) => {
      e.preventDefault();
      st.how = !st.how;
      panel.querySelector(".ael-how").className = "ael-how" + (st.how ? " ael-on" : "");
    };
    panel.querySelector(".ael-go").onclick = () => lockIn(B, n, t);
  };

  const paintRefusal = (B, panel, code, message) => {
    const w = refusalWords(code, message);
    const sizeForm =
      code === "no_size"
        ? '<div class="ael-size-form"><input type="number" min="1" max="10000" step="1" placeholder="pays $" aria-label="Payout in dollars" /><button type="button" class="ael-go ael-quiet">Price it</button></div>'
        : "";
    panel.innerHTML = '<div class="ael-ph"><b>' + esc(w.why) + "</b>" + (w.next ? "<span>" + esc(w.next) + "</span>" : "") + "</div>" + sizeForm + '<div class="ael-fine">' + (code === "spread" || code === "no_size" ? "" : "Protection is offered when the market pays for it. ") + '<a href="#" class="ael-close-a">close</a></div>' + DISCLOSE;
    panel.querySelector(".ael-close-a").onclick = (e) => {
      e.preventDefault();
      stateOf(B.ticker).open = false;
      paintRow(B);
    };
    if (sizeForm) {
      const inp = panel.querySelector("input");
      panel.querySelector(".ael-quiet").onclick = () => {
        const pays = Math.round(Number(inp.value) || 0);
        if (pays < 1) return;
        B.size = { contracts: pays, entryCents: null, stakeCents: 0, payoutCents: pays * 100 };
        B.from = "entered";
        quoteRow(B);
        paintRow(B);
      };
    }
  };

  const lockIn = async (B, n, t) => {
    const st = stateOf(B.ticker);
    if (st.busy) return;
    st.busy = true;
    const go = B.box.querySelector(".ael-go");
    go.disabled = true;
    const t0 = Date.now();
    go.textContent = "Locking in…";
    const tick = setInterval(() => {
      const g = B.box && B.box.querySelector(".ael-go");
      if (g) g.textContent = "Locking in… " + Math.round((Date.now() - t0) / 1000) + "s";
    }, 1000);
    const r = await api("/api/shadow/lock", "POST", { ticker: B.ticker, contracts: n, entryCents: (B.size && B.size.entryCents) || undefined, tier: st.tier || undefined });
    clearInterval(tick);
    st.busy = false;
    if (!r.ok || !r.json || !r.json.ok) {
      st.quote = { ok: false, code: (r.json && r.json.code) || "lock_failed", message: (r.json && (r.json.message || r.json.error)) || r.error || "The lock did not go through. Nothing changed." };
      paintRow(B);
      return;
    }
    st.done = { ticker: B.ticker, at: r.json.at, status: "open", contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: r.json.creditCents, sideName: r.json.sideName, eventTimeIso: r.json.eventTimeIso, hedge: r.json.hedge || null, justNow: true };
    S.record.set(B.ticker, st.done);
    st.open = true;
    paintRow(B);
    setTimeout(loadRecord, 3000);
  };

  /** The protected position's details: only what the holder needs to see the deal they have. */
  const paintDetails = (B, panel, rec) => {
    const rs = reshape(rec.contracts, rec.floorCents, rec.capCents, rec.creditCents);
    const nick = shortOf(B.ticker);
    const h = rec.hedge;
    const opLine =
      S.settings.showHedge === "yes" && h
        ? '<div class="ael-op">' + (h.simulated ? "hedge held: " + esc(h.fallbackReason || "simulated") : "hedged live &middot; order " + esc(h.orderId || "") + " &middot; " + (h.costCents != null ? esc(usd(h.costCents)) : "")) + "</div>"
        : "";
    let head;
    let rows;
    if (rec.status === "settled" && rec.result) {
      const got = rec.protectedCents != null ? rec.protectedCents : rec.result === "yes" ? rs.capTotal : rs.floorTotal;
      const naked = rec.nakedCents != null ? rec.nakedCents : rec.result === "yes" ? 100 * rec.contracts : 0;
      head = "<b>Settled &middot; " + esc(nick) + (rec.result === "yes" ? " won" : " lost") + "</b><span>" + (rec.settledAt ? esc(fmtAt(rec.settledAt)) : "") + "</span>";
      rows = '<div class="ael-kv"><span>You received</span><b>' + esc(usd(got)) + '</b></div><div class="ael-kv"><span>Unprotected it would have paid</span><b>' + esc(usd(naked)) + "</b></div>";
    } else if (rec.status === "void") {
      head = "<b>Protection voided</b><span>no official result for this game</span>";
      rows = '<div class="ael-kv"><span>Nothing owed either way</span><b></b></div>';
    } else {
      head = rec.justNow
        ? '<div class="ael-ck">&#x2713;</div><b>Locked in</b><span>' + esc(nick) + " &middot; settles when the game is final &middot; nothing to manage</span>"
        : "<b>Protected" + (rec.at ? " &middot; locked " + esc(fmtAt(rec.at)) : "") + "</b><span>" + esc(nick) + " &middot; settles when the game is final</span>";
      rows = '<div class="ael-kv"><span>Worst case</span><b>' + esc(usd(rs.floorTotal)) + '</b></div><div class="ael-kv"><span>Best case</span><b>' + esc(usd(rs.capTotal)) + '</b></div><div class="ael-kv"><span>Paid now</span><b>+' + esc(usd(rec.creditCents)) + "</b></div>";
    }
    const recordUrl = (S.baseUrl || "").replace(/\/+$/, "") + "/";
    panel.innerHTML =
      '<div class="ael-ph">' + head + "</div>" + rows + opLine +
      '<div class="ael-fine"><a href="' + esc(recordUrl) + '" target="_blank" rel="noopener">public record</a> &middot; <a href="#" class="ael-close-a">close</a></div>' +
      '<div class="ael-disclose">Third-party protection by Atticus; not a product of this venue.</div>';
    panel.querySelector(".ael-close-a").onclick = (e) => {
      e.preventDefault();
      const st = stateOf(B.ticker);
      st.open = false;
      if (st.done) st.done.justNow = false;
      const r = S.record.get(B.ticker);
      if (r) r.justNow = false;
      paintRow(B);
    };
  };

  // ── the fallback card: the service knows the positions but no row on the page was read ──
  const ensureCard = () => {
    let c = document.getElementById("ael-card");
    if (c) return c;
    c = document.createElement("div");
    c.id = "ael-card";
    c.className = "ael-ui ael-card";
    c.innerHTML = '<div class="ael-card-h"><span>Your positions &middot; protection</span><button type="button" class="ael-x" aria-label="Hide">&times;</button></div><div class="ael-card-b"></div>';
    c.querySelector(".ael-x").onclick = () => {
      c.style.display = "none";
      S.cardHidden = true;
    };
    document.body.appendChild(c);
    return c;
  };

  const paintCard = (show) => {
    const card = document.getElementById("ael-card");
    if (!show) {
      if (card) card.style.display = "none";
      return;
    }
    const c = ensureCard();
    if (S.cardHidden) return;
    c.style.display = "";
    const body = c.querySelector(".ael-card-b");
    const live = new Set();
    for (const p of S.svc.positions) {
      live.add(p.id);
      let B = S.cardRows.get(p.id);
      if (!B) {
        const item = document.createElement("div");
        item.className = "ael-ui ael-card-row";
        item.innerHTML = '<div class="ael-card-pos"><b>' + esc(p.side || "position") + "</b><span>" + esc(p.event || "") + (p.startsIso ? " &middot; " + esc(fmtAt(p.startsIso)) : "") + " &middot; pays " + esc(usd(p.payoutCents)) + "</span></div>" + '<div class="ael-ui ael-row"></div>';
        body.appendChild(item);
        B = { row: item, host: item, box: item.querySelector(".ael-row"), ticker: p.ticker || "__" + p.id, kind: "winner", size: { contracts: p.contracts, entryCents: p.entryCents, stakeCents: p.costCents, payoutCents: p.payoutCents }, from: "service", card: true };
        S.cardRows.set(p.id, B);
      }
      if (B.ticker.startsWith("__")) {
        const st = stateOf(B.ticker);
        st.quote = { ok: false, code: p.reason || "unavailable", message: "" };
      } else quoteRow(B);
      paintRow(B);
    }
    for (const [id, B] of S.cardRows) {
      if (!live.has(id)) {
        B.row.remove();
        S.cardRows.delete(id);
      }
    }
  };

  /** One small line, bottom left, only on the portfolio page and only when the service cannot answer. */
  const paintNotice = (text) => {
    let n = document.getElementById("ael-note");
    if (!text) {
      if (n) n.style.display = "none";
      return;
    }
    if (!n) {
      n = document.createElement("div");
      n.id = "ael-note";
      n.className = "ael-ui ael-note";
      document.body.appendChild(n);
    }
    n.style.display = "";
    n.innerHTML = '<span class="ael-ic">' + SHIELD + "</span>" + esc(text);
  };

  // ── the scan ────────────────────────────────────────────────────────────────
  let scanTimer = null;
  const scan = (force) => {
    const now = Date.now();
    if (!force && now - S.lastScan < SCAN_MIN_GAP_MS) {
      if (!scanTimer) scanTimer = setTimeout(() => scan(true), SCAN_MIN_GAP_MS - (now - S.lastScan) + 10);
      return;
    }
    clearTimeout(scanTimer);
    scanTimer = null;
    S.lastScan = now;
    S.pageOk = onPortfolioPage();
    if (!S.pageOk) {
      for (const [, B] of S.rows) B.host && B.host.remove();
      S.rows.clear();
      paintCard(false);
      paintNotice("");
      return;
    }
    paintNotice(S.serviceState === "key" ? "Lock in: the lock key is missing or wrong. Open the extension's settings." : S.serviceState === "off" ? "Lock in: the service has no lock routes configured." : S.serviceState === "down" ? "Lock in: the service is unreachable." : "");
    const found = findRows(textNodes());
    const live = new Set();
    for (const F of found) {
      live.add(F.row);
      let B = S.rows.get(F.row);
      if (B && B.ticker !== F.ticker) {
        B.host.remove();
        B = null;
      }
      if (!B) {
        B = { ...F, host: null, box: null };
        S.rows.set(F.row, B);
        mountHost(B);
      } else {
        // a size the holder typed survives a page that still cannot be read; anything read wins
        if (F.from !== "none" || B.from !== "entered") {
          B.size = F.size;
          B.from = F.from;
        }
        B.kind = F.kind;
        if (!B.host.isConnected) mountHost(B);
      }
      quoteRow(B);
      paintRow(B);
    }
    for (const [row, B] of S.rows) {
      if (!live.has(row) || !row.isConnected) {
        B.host && B.host.remove();
        S.rows.delete(row);
      }
    }
    paintCard(found.length === 0 && S.svc.configured && S.svc.positions.length > 0);
  };

  // ── start ───────────────────────────────────────────────────────────────────
  let raf = null;
  const observer = new MutationObserver((muts) => {
    if (raf) return;
    if (muts.every((m) => OURS(m.target))) return;
    raf = requestAnimationFrame(() => {
      raf = null;
      scan(false);
    });
  });

  const start = async () => {
    S.settings = await loadSettings();
    S.baseUrl = S.settings.baseUrl || "https://atticus-event-shadow.onrender.com";
    await loadMarkets();
    void loadPositions();
    void loadRecord();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    setInterval(loadMarkets, POLL_MARKETS_MS);
    setInterval(() => {
      if (S.pageOk) void loadPositions();
    }, POLL_POSITIONS_MS);
    setInterval(() => {
      if (S.pageOk) void loadRecord();
    }, POLL_RECORD_MS);
    setInterval(() => scan(false), 2_000);
    setInterval(() => {
      for (const [, B] of S.rows) fitHost(B);
    }, 500);
    window.addEventListener("resize", () => {
      for (const [, B] of S.rows) fitHost(B);
    });
    window.addEventListener("hashchange", () => scan(true));
    window.addEventListener("popstate", () => scan(true));
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
  // inert inside the extension (isolated world); lets a page-level harness read state when it injects this file
  if (window.__AEL_DEBUG) window.__ael = S;
})();
