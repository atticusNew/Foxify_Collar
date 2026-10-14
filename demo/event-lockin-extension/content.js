// Atticus Earn & Protect: Lock in (content script).
//
// Three things are drawn on the venue's page, and nothing else:
//   1. a small shield beside a team's name wherever protection is offered on that side right now
//      (game list, game page, portfolio). Sides with nothing offered get nothing: no greyed icon,
//      no "unavailable" word;
//   2. a "Lock in" line under the venue's order slip once a Winner pick with a wager is in it; it
//      shows the paid-now amount at that wager, priced live, before the tap;
//   3. our panel, docked over the slip's column (desktop) or as a bottom sheet (phone).
// That placement is the only staged pixel of the demo and it is disclosed on the panel. Behind the
// tap is the Atticus event service: the game is matched, the position is priced from live books at
// the holder's size, the terms lock, the record is written, the hedge is bought.
//
// Selector strategy: the venue's web app is a React SPA with no stable ids, so everything is read
// from text. A team is a text node naming a nickname the service can protect ("IND Colts"); the
// slip is the smallest element reading "Payout: $37.03" plus the input and the pick beside it
// ("IND Colts · Winner"). Overlays are positioned from those rects and hidden when the anchor is
// covered (the venue's header stays while the page scrolls under it), so nothing we draw floats
// over the wrong thing. The venue's DOM is never modified; our elements live on document.body.
//
// Nothing here holds credentials. The lock key lives in extension storage and is attached by the
// background worker; the venue's own session is never read or used.

(() => {
  const POLL_MARKETS_MS = 5 * 60_000;
  const AVAIL_TTL_MS = 5 * 60_000;
  const SCAN_MIN_GAP_MS = 500;
  const QUOTE_CONCURRENCY = 3;
  const PILL_AFTER_MS = 8_000;
  // the shield answers "is protection offered on this side", checked at a normal size: the smallest
  // sizes sit on the minimum-credit line and would flicker with every tick of the book
  const AVAIL_MIN_CONTRACTS = 50;
  const TIER_ORDER = ["tight", "balanced", "wide"];
  const TIER_WORDS = { tight: "Most now", balanced: "Balanced", wide: "Most upside" };
  const DEFAULTS = { defaultContracts: 20, showHedge: "no" };
  const SHIELD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>';
  const SHIELD_CHECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/></svg>';

  const S = {
    settings: { ...DEFAULTS },
    markets: [],
    byTicker: {},
    nicks: new Map(), // nickname (lower) -> [{ ticker, league, code }]
    nickRe: null,
    labels: new Map(), // text node -> { ticker, icon, size }
    slip: null, // { card, payoutEl, column, ticker, kind, contracts, entryCents, stake, payout, key }
    slipQuote: null, // { key, r }
    avail: new Map(), // ticker -> { at, ok, creditCents, floorCents, capCents, contracts, detail }
    pending: new Set(),
    locked: new Map(), // ticker -> { contracts, floorCents, capCents, creditCents, sideName, hedge }
    open: null,
    quote: null,
    tier: null,
    contracts: null,
    entryCents: null,
    busy: false,
    how: false,
    adjust: false,
    pickerLeague: "",
    serviceState: "loading",
    startedAt: Date.now(),
    lastScan: 0,
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
  // the venue's short codes where they differ from Kalshi's
  const CODE_ALIAS = { LA: ["LAR", "LAC"], LAR: ["LA"], LAC: ["LA"], JAX: ["JAC"], JAC: ["JAX"], WSH: ["WAS"], WAS: ["WSH"], CHW: ["CWS"], CWS: ["CHW"], ATH: ["OAK"], OAK: ["ATH"], GS: ["GSW"], GSW: ["GS"], NY: ["NYK"], NYK: ["NY"], SA: ["SAS"], SAS: ["SA"], NO: ["NOP"], NOP: ["NO"] };
  const codeOf = (ticker) => String(ticker || "").slice(String(ticker || "").lastIndexOf("-") + 1);
  const nickOf = (m) => (NICK[String(m.league || "").toLowerCase()] || {})[codeOf(m.ticker)] || null;
  const labelOf = (m) => {
    const city = String(m.sideName || "").trim().replace(/\s+[A-Z]$/, "");
    const nick = nickOf(m);
    return nick ? (city ? city + " " + nick : nick) : city || m.ticker;
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
    S.nickRe = keys.length ? new RegExp("(^|[^a-z0-9])(" + keys.join("|") + ")(?![a-z0-9])", "i") : null;
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

  /** The other side of the same game, when the service lists it. */
  const otherSide = (ticker) => {
    const stem = ticker.slice(0, ticker.lastIndexOf("-"));
    return S.markets.find((m) => m.ticker !== ticker && m.ticker.startsWith(stem + "-")) || null;
  };

  /**
   * The side a piece of text names: a nickname the service can protect, disambiguated by the team
   * code printed before it ("ARI Cardinals" is football, "STL Cardinals" baseball). Null when no
   * nickname, or when two games share one and no code settles it.
   */
  const sideIn = (text) => {
    if (!S.nickRe) return null;
    const m = S.nickRe.exec(text);
    if (!m) return null;
    const list = S.nicks.get(m[2].toLowerCase()) || [];
    if (list.length === 1) return list[0].ticker;
    const before = text.slice(0, m.index + m[1].length).trim();
    const code = /(?:^|[^A-Za-z])([A-Z]{2,3})$/.exec(before);
    if (code) {
      const c = code[1];
      const hit = list.filter((x) => x.code === c || (CODE_ALIAS[c] || []).includes(x.code));
      if (hit.length === 1) return hit[0].ticker;
    }
    return null;
  };

  // ── reading sizes ───────────────────────────────────────────────────────────
  const MONEY = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  const MULTIPLIER = /(?:^|[^\d.])(\d{1,2}\.\d{1,3})\s?x(?![a-z])/i;
  const amountsIn = (text) => {
    const out = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(text))) out.push(Number(m[1].replace(/,/g, "")));
    return out;
  };
  /** $1 contracts and entry price from a stake and its payout. */
  const sizeOf = (stake, payout) => ({
    contracts: Math.max(1, Math.round(payout)),
    entryCents: Math.min(99, Math.max(1, Math.round((100 * stake) / payout))),
  });
  /** Two dollar amounts a multiplier apart are a stake and its payout (a portfolio row). Null otherwise. */
  const pairIn = (text) => {
    const mult = MULTIPLIER.exec(text);
    if (!mult || !(Number(mult[1]) > 1)) return null;
    const k = Number(mult[1]);
    const amounts = amountsIn(text);
    for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && Math.abs(b - a * k) <= Math.max(0.02, 0.01 * b)) return sizeOf(a, b);
    return null;
  };

  // ── finding things on the page ──────────────────────────────────────────────
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
        if (!t || t.length < 3 || t.length > 60 || !/[A-Za-z]/.test(t)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  };

  const rectOfNode = (node) => {
    if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    }
    return node.getBoundingClientRect();
  };

  /**
   * The name's rect, extended to the end of the words printed on the same line right after it
   * ("IND Colts" + "at" + "2-3"), so the icon lands after the row's text and not on top of it.
   * Boxes further than a word gap away (the odds cells) are not chained.
   */
  const lineEndRect = (node) => {
    const r = rectOfNode(node);
    let right = r.right;
    let root = node.parentElement;
    for (let i = 0; i < 3 && root && root.parentElement && root.parentElement !== document.body; i++) root = root.parentElement;
    if (!root) return r;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const midY = (r.top + r.bottom) / 2;
    let t;
    while ((t = walker.nextNode())) {
      if (t === node || !norm(t.nodeValue) || OURS(t)) continue;
      const rr = rectOfNode(t);
      if (rr.width === 0) continue;
      const sameLine = Math.abs((rr.top + rr.bottom) / 2 - midY) < Math.max(6, r.height / 2);
      if (sameLine && rr.left >= r.left - 1 && rr.left - right < 40 && rr.right > right) right = rr.right;
    }
    return { top: r.top, bottom: r.bottom, left: r.left, right, height: r.height, width: right - r.left };
  };

  /** The smallest element under `root` whose text matches `re`. */
  const smallest = (root, re, maxLen) => {
    let best = null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (e) => (e.closest(".ael-ui") || e.tagName === "SCRIPT" || e.tagName === "STYLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    let e = root;
    while (e) {
      const t = norm(e.textContent);
      if (t.length <= maxLen && re.test(t) && (!best || t.length <= norm(best.textContent).length)) best = e;
      e = walker.nextNode();
    }
    return best;
  };

  /** The first short text under `root` that names a protectable side. */
  const teamNodeIn = (root) => {
    if (!S.nickRe) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let t;
    while ((t = walker.nextNode())) {
      const text = norm(t.nodeValue);
      if (text.length < 3 || text.length > 48 || OURS(t)) continue;
      if (S.nickRe.test(text) && sideIn(text)) return t;
    }
    return null;
  };

  const PAYOUT = /^payout:?\s*\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?$/i;
  const PICK = /^(.{2,48}?)\s*[·•|]\s*(Spread|Total|Winner|Moneyline|Money Line|ML)\s*$/i;

  /** The elements reading exactly "Payout: $x" (the label and the amount may be separate nodes). */
  const payoutEls = (nodes) => {
    const out = [];
    for (const node of nodes) {
      if (!/payout/i.test(node.nodeValue)) continue;
      let e = node.parentElement;
      for (let i = 0; i < 3 && e && e !== document.body; i++, e = e.parentElement) {
        if (PAYOUT.test(norm(e.textContent))) {
          if (!out.includes(e)) out.push(e);
          break;
        }
      }
    }
    return out;
  };

  /**
   * The venue's order slip: an element reading "Payout: $x", then the card around it that also
   * holds the wager input and the pick ("IND Colts · Winner"). Size is the payout in $1
   * contracts; entry is wager over payout.
   */
  const findSlip = (nodes) => {
    let payoutEl = null;
    let card = null;
    let input = null;
    let pickEl = null;
    let teamNode = null;
    for (const candidate of payoutEls(nodes)) {
      let c = candidate;
      input = null;
      pickEl = null;
      teamNode = null;
      for (let i = 0; i < 8 && c && c.parentElement && c.parentElement !== document.body; i++) {
        c = c.parentElement;
        input = input || [...c.querySelectorAll("input")].find((x) => !x.closest(".ael-ui") && /^(text|number|tel|decimal)?$/.test(x.type || ""));
        pickEl = pickEl || smallest(c, PICK, 60);
        teamNode = teamNode || teamNodeIn(c);
        if (input && (pickEl || teamNode)) break;
      }
      if (input && (pickEl || teamNode)) {
        payoutEl = candidate;
        card = c;
        break;
      }
    }
    if (!card) return null;
    // "IND Colts · Winner" on one line is the clean read; a slip that prints the team and the market
    // on separate lines is read from its words instead
    const pickText = pickEl ? norm(pickEl.textContent) : "";
    const pick = PICK.exec(pickText);
    const cardText = norm(card.textContent);
    const ticker = pick ? sideIn(pick[1]) : teamNode ? sideIn(norm(teamNode.nodeValue)) : null;
    const kind = pick
      ? /winner|moneyline|money line|^ml$/i.test(pick[2])
        ? "winner"
        : pick[2].toLowerCase()
      : /\bspread\b/i.test(cardText)
        ? "spread"
        : /\b(total|over|under)\b/i.test(cardText)
          ? "total"
          : "winner";
    const payout = amountsIn(norm(payoutEl.textContent))[0] || 0;
    const stakeRaw = input ? String(input.value || "").replace(/[$,\s]/g, "") : "";
    const stake = Number(stakeRaw) || 0;
    const size = payout > 0 ? sizeOf(stake > 0 ? stake : payout, payout) : null;
    const picks = [...card.querySelectorAll("*")].filter((e) => !e.closest(".ael-ui") && e.children.length === 0 && PICK.test(norm(e.textContent))).length;
    return {
      card,
      payoutEl,
      column: columnOf(card),
      ticker,
      kind,
      pickText: pick ? norm(pick[1]) : pickText,
      multi: picks > 1,
      contracts: size ? size.contracts : null,
      entryCents: size && stake > 0 ? size.entryCents : null,
      stake,
      payout,
    };
  };

  /** The slip's column: the widest ancestor that still sits in the right half and reaches the right edge. */
  const columnOf = (card) => {
    let best = null;
    let n = card;
    while (n && n !== document.body) {
      const r = n.getBoundingClientRect();
      if (r.width >= 220 && r.width <= window.innerWidth * 0.5 && r.left >= window.innerWidth * 0.45 && r.right >= window.innerWidth - 48) best = n;
      n = n.parentElement;
    }
    return best;
  };

  /** Team labels: text nodes naming a protectable side, short enough to be a name and not a sentence. */
  const findLabels = (slip, nodes) => {
    const out = [];
    if (!S.nickRe) return out;
    for (const node of nodes) {
      const t = norm(node.nodeValue);
      const m = S.nickRe.exec(t);
      if (!m || t.length > m[2].length + 16) continue;
      if (slip && slip.card.contains(node)) continue;
      const ticker = sideIn(t);
      if (!ticker) continue;
      // a portfolio row around the name carries the stake and payout; a game row does not
      let size = null;
      let p = node.parentElement;
      for (let i = 0; i < 6 && p && p !== document.body && !size; i++, p = p.parentElement) {
        const text = norm(p.textContent);
        if (text.length > 320) break;
        size = pairIn(text);
      }
      out.push({ node, ticker, size });
    }
    return out;
  };

  // ── availability: one live quote per side on screen, cached a few minutes ──
  const availOf = (ticker) => {
    const a = S.avail.get(ticker);
    return a && Date.now() - a.at < AVAIL_TTL_MS ? a : null;
  };

  const queueAvailability = () => {
    if (S.serviceState !== "ok") return;
    if (S.pending.size >= QUOTE_CONCURRENCY) return;
    const want = [];
    const seen = new Set();
    for (const [node, L] of S.labels) {
      if (seen.has(L.ticker) || availOf(L.ticker) || S.pending.has(L.ticker) || S.locked.has(L.ticker)) continue;
      const r = rectOfNode(node);
      if (r.bottom < -200 || r.top > window.innerHeight + 200) continue;
      seen.add(L.ticker);
      want.push(L.ticker);
    }
    // favourites first: that is where protection is usually offered, so the icons land where the eye goes
    want.sort((a, b) => ((S.byTicker[b] || {}).markCents || 0) - ((S.byTicker[a] || {}).markCents || 0));
    for (const ticker of want.slice(0, QUOTE_CONCURRENCY - S.pending.size)) {
      S.pending.add(ticker);
      const n = Math.max(S.settings.defaultContracts || 20, AVAIL_MIN_CONTRACTS);
      api("/api/shadow/quote?ticker=" + encodeURIComponent(ticker) + "&contracts=" + n, "GET").then((r) => {
        S.pending.delete(ticker);
        const p = r.ok && r.json ? r.json : null;
        const q = p && p.ok && p.quote && p.quote.ok ? p.quote : null;
        S.avail.set(ticker, q ? { at: Date.now(), ok: true, contracts: n, floorCents: q.floorCents, capCents: q.capCents, creditCents: q.creditCents } : { at: Date.now(), ok: false, detail: p ? p.message || (p.quote && p.quote.detail) || "" : r.error || "" });
        paintIcons();
        queueAvailability();
      });
    }
  };

  // ── overlays ────────────────────────────────────────────────────────────────
  /** True when the anchor is on screen and not covered by the venue's own fixed chrome. */
  const showing = (rect, ownerNode) => {
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth) return false;
    const x = Math.min(window.innerWidth - 1, Math.max(0, rect.left + rect.width / 2));
    const y = Math.min(window.innerHeight - 1, Math.max(0, rect.top + rect.height / 2));
    const top = document.elementsFromPoint(x, y).find((e) => !e.closest(".ael-ui"));
    if (!top) return false;
    const owner = ownerNode.nodeType === 3 ? ownerNode.parentElement : ownerNode;
    return Boolean(owner && (owner.contains(top) || top.contains(owner)));
  };

  const ensureIcon = (node, ticker) => {
    const L = S.labels.get(node);
    if (L && L.icon) return L.icon;
    const b = document.createElement("button");
    b.className = "ael-ui ael-icon";
    b.type = "button";
    b.innerHTML = SHIELD;
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSheet(ticker);
    });
    document.body.appendChild(b);
    return b;
  };

  const paintIcons = () => {
    for (const [node, L] of S.labels) {
      const a = availOf(L.ticker);
      const locked = S.locked.get(L.ticker);
      const m = S.byTicker[L.ticker] || {};
      if (locked) {
        L.icon.className = "ael-ui ael-icon ael-icon-locked";
        L.icon.innerHTML = SHIELD_CHECK;
        L.icon.title = "Locked in: +" + usd(locked.creditCents) + " paid, ends " + usd(reshape(locked.contracts, locked.floorCents, locked.capCents, locked.creditCents).floorTotal) + " or " + usd(reshape(locked.contracts, locked.floorCents, locked.capCents, locked.creditCents).capTotal);
        L.show = true;
      } else if (a && a.ok) {
        L.icon.className = "ael-ui ael-icon";
        L.icon.innerHTML = SHIELD;
        L.icon.title = "Protection available on " + labelOf(m) + (L.size ? ": lock in at your " + L.size.contracts + " contracts" : ": paid now, floor if it loses");
        L.show = true;
      } else {
        L.show = false;
      }
    }
    positionOverlays();
  };

  const ensureSlipButton = () => {
    let b = el("ael-slip");
    if (b) return b;
    b = document.createElement("div");
    b.id = "ael-slip";
    b.className = "ael-ui ael-slip";
    document.body.appendChild(b);
    return b;
  };

  const slipKey = (s) => (s && s.ticker ? [s.ticker, s.contracts, s.entryCents].join("|") : "");

  /** Price the slip's pick at its wager, debounced, so the line shows the paid-now amount before the tap. */
  let slipTimer = null;
  const quoteSlip = () => {
    const s = S.slip;
    const key = slipKey(s);
    if (!key || !s.contracts || s.kind !== "winner" || s.multi) return;
    if (S.slipQuote && S.slipQuote.key === key) return;
    if (S.slipQuote && S.slipQuote.pendingKey === key) return;
    clearTimeout(slipTimer);
    slipTimer = setTimeout(() => {
      const cur = S.slip;
      if (slipKey(cur) !== key) return;
      S.slipQuote = { key: null, pendingKey: key, r: null };
      api("/api/shadow/quote?ticker=" + encodeURIComponent(cur.ticker) + "&contracts=" + cur.contracts + (cur.entryCents ? "&entry=" + cur.entryCents : ""), "GET").then((r) => {
        if (slipKey(S.slip) !== key) return;
        S.slipQuote = { key, r };
        paintSlip();
      });
      paintSlip();
    }, 450);
  };

  const paintSlip = () => {
    const s = S.slip;
    const b = ensureSlipButton();
    if (!s || !s.ticker) {
      b.style.display = "none";
      return;
    }
    const m = S.byTicker[s.ticker] || {};
    const name = labelOf(m);
    const locked = S.locked.get(s.ticker);
    let html = "";
    let cls = "ael-ui ael-slip";
    if (locked) {
      const rs = reshape(locked.contracts, locked.floorCents, locked.capCents, locked.creditCents);
      cls += " ael-slip-locked";
      html = '<button type="button" class="ael-slip-go" id="ael-slip-go">' + SHIELD_CHECK + "<span>Locked &middot; +" + esc(usd(locked.creditCents)) + " paid</span></button><div class=\"ael-slip-cap\">Ends " + esc(usd(rs.floorTotal)) + " or " + esc(usd(rs.capTotal)) + ". Settles with your position.</div>";
    } else if (s.multi) {
      cls += " ael-slip-muted";
      html = '<div class="ael-slip-note">Protection is priced one pick at a time.</div>';
    } else if (s.kind !== "winner") {
      cls += " ael-slip-muted";
      html = '<div class="ael-slip-note">Protection covers the Winner market. Pick <b>' + esc(name) + " &middot; Winner</b> to lock it in.</div>";
    } else if (!s.contracts) {
      cls += " ael-slip-muted";
      html = '<div class="ael-slip-note">' + SHIELD + "<span>Enter a wager to see what protection pays now.</span></div>";
    } else {
      const sq = S.slipQuote && S.slipQuote.key === slipKey(s) ? S.slipQuote.r : null;
      const p = sq && sq.ok && sq.json ? sq.json : null;
      const q = p && p.ok && p.quote && p.quote.ok ? p.quote : null;
      if (!sq) {
        html = '<button type="button" class="ael-slip-go" id="ael-slip-go">' + SHIELD + '<span>Lock in</span><em class="ael-skel-inline"></em></button><div class="ael-slip-cap">Pricing protection at your wager&hellip;</div>';
      } else if (q) {
        const rs = reshape(q.contracts || s.contracts, q.floorCents, q.capCents, q.creditCents);
        // the slip's own quote is the freshest word on this side: keep the row's shield in step with it
        S.avail.set(s.ticker, { at: Date.now(), ok: true, contracts: q.contracts || s.contracts, floorCents: q.floorCents, capCents: q.capCents, creditCents: q.creditCents });
        html = '<button type="button" class="ael-slip-go" id="ael-slip-go">' + SHIELD + "<span>Lock in</span><em>+" + esc(usd(q.creditCents)) + " now</em></button><div class=\"ael-slip-cap\">Ends <b>" + esc(usd(rs.floorTotal)) + "</b> if " + esc(name) + " loses, <b>" + esc(usd(rs.capTotal)) + "</b> if it wins &middot; priced live</div>";
      } else {
        cls += " ael-slip-muted";
        const code = p && p.quote && !p.quote.ok ? p.quote.code : p && !p.ok ? p.code : "";
        const why = p && !p.ok ? p.message : p && p.quote && !p.quote.ok ? p.quote.detail : sq.status === 403 ? "lock key missing or wrong" : "live pricing unavailable";
        html = /credit/.test(code || "")
          ? '<div class="ael-slip-note">' + SHIELD + "<span>Protection on this pick starts at a larger wager.</span><small>" + esc(why || "") + "</small></div>"
          : '<div class="ael-slip-note">Protection isn\'t offered on this pick right now.<small>' + esc(why || "") + "</small></div>";
      }
    }
    b.className = cls;
    b.innerHTML = html;
    b.style.display = "";
    const go = el("ael-slip-go");
    if (go)
      go.onclick = (e) => {
        e.preventDefault();
        S.contracts = s.contracts;
        S.entryCents = s.entryCents;
        openSheet(s.ticker, true);
      };
    positionOverlays();
  };

  const positionOverlays = () => {
    for (const [node, L] of S.labels) {
      if (!node.isConnected) {
        L.icon.remove();
        S.labels.delete(node);
        continue;
      }
      const r = rectOfNode(node);
      if (!L.show || !showing(r, node)) {
        L.icon.style.display = "none";
        continue;
      }
      L.icon.style.display = "";
      const line = lineEndRect(node);
      L.icon.style.top = Math.round(r.top + r.height / 2 - 9) + "px";
      L.icon.style.left = Math.round(line.right + 7) + "px";
    }
    const b = el("ael-slip");
    const s = S.slip;
    if (b && s && b.style.display !== "none") {
      if (!s.card.isConnected) {
        b.style.display = "none";
      } else {
        const r = s.card.getBoundingClientRect();
        if (!showing(r, s.card)) b.style.display = "none";
        else {
          b.style.top = Math.round(r.bottom + 8) + "px";
          b.style.left = Math.round(r.left) + "px";
          b.style.width = Math.round(r.width) + "px";
        }
      }
    }
    dockSheet();
  };

  const ensurePill = () => {
    let p = el("ael-pill");
    if (p) return p;
    p = document.createElement("button");
    p.id = "ael-pill";
    p.className = "ael-ui ael-pill";
    p.type = "button";
    p.innerHTML = SHIELD + "<span>Protection</span>";
    p.addEventListener("click", () => openPicker());
    document.body.appendChild(p);
    return p;
  };

  // ── the scan: labels, slip, icons, line ─────────────────────────────────────
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
    const nodes = textNodes();
    const slip = findSlip(nodes);
    S.slip = slip;
    if (!slip) S.slipQuote = null;
    const labels = findLabels(slip, nodes);
    const live = new Set();
    for (const L of labels) {
      live.add(L.node);
      const cur = S.labels.get(L.node);
      if (cur && cur.ticker === L.ticker) {
        cur.size = L.size;
        continue;
      }
      if (cur) cur.icon.remove();
      S.labels.set(L.node, { ticker: L.ticker, icon: ensureIcon(L.node, L.ticker), size: L.size, show: false });
    }
    for (const [node, L] of S.labels) {
      if (!live.has(node)) {
        L.icon.remove();
        S.labels.delete(node);
      }
    }
    queueAvailability();
    paintIcons();
    paintSlip();
    quoteSlip();
    const pill = ensurePill();
    const nothing = !labels.length && !slip && now - S.startedAt > PILL_AFTER_MS;
    pill.style.display = nothing ? "" : "none";
    pill.title = S.serviceState === "key" ? "Lock key missing or wrong: open the extension's settings" : S.serviceState === "off" ? "The service has no lock routes configured" : S.serviceState === "down" ? "The service is unreachable" : "Pick a game to protect";
  };

  // ── the panel (ours, the same in any host) ──────────────────────────────────
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

  /** Dock the panel over the slip's column when the page has one; the stylesheet's dock otherwise. */
  const dockSheet = () => {
    const sheet = el("ael-sheet");
    if (!sheet) return;
    const col = S.slip && S.slip.column && S.slip.column.isConnected ? S.slip.column.getBoundingClientRect() : null;
    if (col && window.innerWidth >= 900) {
      const top = Math.max(8, col.top + 8);
      sheet.classList.add("ael-docked");
      sheet.style.top = Math.round(top) + "px";
      sheet.style.left = Math.round(col.left + 8) + "px";
      sheet.style.width = Math.round(col.width - 16) + "px";
      sheet.style.maxWidth = sheet.style.width;
      sheet.style.maxHeight = Math.round(window.innerHeight - top - 12) + "px";
      sheet.style.right = "auto";
    } else {
      sheet.classList.remove("ael-docked");
      sheet.style.top = sheet.style.left = sheet.style.width = sheet.style.maxWidth = sheet.style.maxHeight = sheet.style.right = "";
    }
  };

  const showSheet = (on) => {
    ensureSheet();
    dockSheet();
    el("ael-scrim").className = "ael-ui ael-scrim" + (on ? " ael-on" : "");
    el("ael-sheet").className = "ael-ui ael-sheet" + (el("ael-sheet").classList.contains("ael-docked") ? " ael-docked" : "") + (on ? " ael-on" : "");
  };

  const closeSheet = () => {
    if (S.busy) return;
    S.open = null;
    S.quote = null;
    showSheet(false);
  };

  const sizeFor = (ticker) => {
    const slip = S.slip && S.slip.ticker === ticker && S.slip.contracts ? S.slip : null;
    let row = null;
    for (const L of S.labels.values()) if (L.ticker === ticker && L.size) row = L.size;
    return {
      contracts: S.contracts || (slip && slip.contracts) || (row && row.contracts) || S.settings.defaultContracts || 20,
      entryCents: S.entryCents !== null ? S.entryCents : slip && slip.entryCents ? slip.entryCents : row ? row.entryCents : null,
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
      if (p.onRecord) return paintRefusal(ticker, "This market is already locked. Pick the other side or another game.");
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

  const DISCLOSE = '<div class="ael-disclose">Third-party protection by Atticus. Button and panel rendered locally for this demo; not a product of this venue. Pricing, record and hedge are live.</div>';
  const DISCLOSE_SHORT = '<div class="ael-disclose">Third-party protection by Atticus. Panel rendered locally for this demo; not a product of this venue.</div>';

  const paintRefusal = (ticker, detail) => {
    const m = S.byTicker[ticker] || {};
    const other = otherSide(ticker);
    const size = sizeFor(ticker);
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in this position</h2><div class="ael-who">' + esc(m.ticker ? labelOf(m) : ticker) + "</div>" + sizeLine(ticker, size.contracts) +
      '<div class="ael-refusal"><b>Not right now.</b> ' + esc(detail) + "</div>" +
      (other ? '<button type="button" class="ael-go ael-quiet" id="ael-other">Try the other side: ' + esc(labelOf(other)) + "</button>" : "") +
      '<button type="button" class="ael-go ael-quiet" id="ael-close">Close</button>' +
      '<div class="ael-fine">The lock is only offered when the market pays you for it.</div>' + DISCLOSE_SHORT;
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
      DISCLOSE;
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
    paintIcons();
    paintSlip();
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
      '<button type="button" class="ael-go" id="ael-done">Done</button><div class="ael-fine">Nothing to manage. It settles with your position.</div>' + DISCLOSE_SHORT;
    el("ael-done").onclick = closeSheet;
  };

  // ── the picker: when nothing on the page reads, choose the game by hand ─────
  const openPicker = () => {
    S.open = "__picker__";
    showSheet(true);
    const leagues = [...new Set(S.markets.map((m) => m.league))];
    const league = S.pickerLeague || leagues[0] || "";
    const rows = S.markets.filter((m) => !league || m.league === league);
    let list = "";
    for (const m of rows) {
      list += '<button type="button" class="ael-pick' + (m.onRecord ? " ael-held" : "") + '" data-ticker="' + esc(m.ticker) + '"' + (m.onRecord ? " disabled" : "") + "><b>" + esc(labelOf(m)) + "</b><span>" + esc(m.title || "") + (m.dateIso ? " &middot; " + esc(m.dateIso) : "") + " &middot; " + m.markCents + "&cent;" + (m.onRecord ? " &middot; locked" : "") + "</span></button>";
    }
    el("ael-body").innerHTML =
      '<h2 id="ael-h">Lock in a position</h2><div class="ael-who">' + (S.serviceState === "ok" ? "Pick the side you hold." : S.serviceState === "key" ? "The lock key is missing or wrong. Open the extension's settings." : S.serviceState === "off" ? "The service has no lock routes configured." : "The service is unreachable.") + "</div>" +
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
    ensureSheet();
    ensurePill().style.display = "none";
    await loadMarkets();
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    document.addEventListener("input", () => scan(false), true);
    setInterval(loadMarkets, POLL_MARKETS_MS);
    setInterval(positionOverlays, 250);
    setInterval(() => scan(false), 2_000);
    window.addEventListener("scroll", positionOverlays, true);
    window.addEventListener("resize", positionOverlays);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && S.open) closeSheet();
    });
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
  // inert inside the extension (isolated world); lets a page-level harness read state when it injects this file
  if (window.__AEL_DEBUG) window.__ael = S;
})();
