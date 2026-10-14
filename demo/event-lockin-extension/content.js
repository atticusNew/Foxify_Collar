// Atticus Earn & Protect: Lock in (content script).
//
// One place, after the trade. On the venue's My Trades page (its list of open plays), each open
// matched play the engine can protect gets one line directly under its row: "Lock in · +$0.60 now"
// with the worst case it buys. Tap it and our panel opens inline under that row, pushing the rows
// below down; nothing floats over the venue's page. Plays we cannot protect get the same line
// muted, and the tap says why. A locked play shows a Protected chip whose details are the four
// things a holder needs: worst case, best case, what was paid, when it settles, and the public record.
//
// Nothing is drawn on the game list, the game page or the play slip. The venue's own flow places
// the play; protection is offered on what the account then holds.
//
// Sizes: when the service has a key for the holder's venue account, every number comes from the
// service's confirmation of the play (GET /api/shadow/positions): the matched stake, what it pays,
// the game. Without it, the row's text is read (stake and To Win, or stake and American odds) and
// the panel says the size was read from the page.
//
// Matching: on this venue a play rests until another account takes the other side. An unmatched
// play is an order, not a position, so it gets the muted line and the tap says it waits for the
// match. A partially matched play is sized on its matched part.
//
// Selector strategy: the venue's web app is a React SPA with no stable ids, so rows are found by
// text: a block that names a team the service can protect and carries the play's money.
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
    codes: new Map(), // team code (upper) -> [ticker]
    nickRe: null,
    tab: null, // "resting" | "filled" | "settled" | null, from the page's tabs
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
    S.codes = new Map();
    for (const m of markets) {
      S.byTicker[m.ticker] = m;
      const code = codeOf(m.ticker);
      for (const c of [code, ...(CODE_ALIAS[code] || [])]) {
        const l = S.codes.get(c) || [];
        if (!l.includes(m.ticker)) l.push(m.ticker);
        S.codes.set(c, l);
      }
      const nick = nickOf(m);
      if (!nick) continue;
      const k = nick.toLowerCase();
      const list = S.nicks.get(k) || [];
      list.push({ ticker: m.ticker, league: m.league, code });
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

  /**
   * Every side the text names, with how often; the pick is named more than once on most rows.
   * A side is a nickname ("Colts", "IND Colts") or, where the venue prints only codes ("NYJ @ NE"),
   * a bare upper-case code that names exactly one market the service can protect this week.
   */
  const CODE_RE = /(^|[^A-Za-z0-9])([A-Z]{2,3})(?![A-Za-z0-9])/g;
  const LEAGUE_WORDS = [
    [/\b(nfl|pro fb|football)\b/i, "nfl"],
    [/\b(nba|pro bb|basketball)\b/i, "nba"],
    [/\b(mlb|pro bsb|baseball)\b/i, "mlb"],
  ];
  const leagueOf = (ticker) => String((S.byTicker[ticker] || {}).league || "").toLowerCase();
  const sidesIn = (raw) => {
    const text = spaced(raw);
    const out = nicksIn(text);
    out.ambiguous = false;
    if (!S.nickRe) return out;
    // codes: unique ones count at once; a code shared across leagues (DEN, TB, KC) is resolved by the
    // row's league word, else by the league of a side already resolved; left unresolved it is flagged
    let league = null;
    for (const [re, l] of LEAGUE_WORDS) if (re.test(text)) { league = l; break; }
    const found = [];
    let m;
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(text))) found.push(S.codes.get(m[2]) || []);
    for (const list of found) if (list.length === 1) out.set(list[0], (out.get(list[0]) || 0) + 1);
    if (!league) {
      const ls = new Set([...out.keys()].map(leagueOf));
      if (ls.size === 1) league = [...ls][0];
    }
    for (const list of found) {
      if (list.length < 2) continue;
      const named = list.filter((t) => out.has(t));
      const pick = named.length === 1 ? named : league ? list.filter((t) => leagueOf(t) === league) : list;
      if (pick.length === 1) out.set(pick[0], (out.get(pick[0]) || 0) + 1);
      else out.ambiguous = true;
    }
    return out;
  };
  const nicksIn = (raw) => {
    const text = spaced(raw);
    const out = new Map();
    if (!S.nickRe) return out;
    let m;
    S.nickRe.lastIndex = 0;
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

  // ── reading sizes off a row (fallback when the service has no key) ──────────
  const MONEY = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  /** The text without its dollar amounts. Cells can touch ("$20.0074.68%"), so only an amount's own shape is removed, never the digits after it. */
  const noMoney = (text) => text.replace(/\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?/g, " ");
  const MULTIPLIER = /(?:^|[^\d.])(\d{1,2}\.\d{1,3})\s?x(?![a-z])/i;
  // American odds: a signed figure of three or more digits that is not a dollar amount (+250, -300)
  const AMERICAN = /(?:^|[^\d.$,])([+-]\d{3,5})(?![\d.,%])/;
  const PERCENT = /(?:^|[^\d.])(\d{1,2}(?:\.\d{1,2})?)\s?%/;
  /** payout per $1 at American odds; null for anything between -99 and 99 */
  const payoutMultiple = (odds) => (odds >= 100 ? 1 + odds / 100 : odds <= -100 ? 1 + 100 / -odds : null);
  /** textContent joins adjacent elements with nothing between ("To Win$2.60Unmatched"); give the words room */
  const spaced = (text) =>
    String(text)
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/(\d)([A-Z])/g, "$1 $2") // "2.60Unmatched" splits; "49ers" and "76ers" stay whole
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") // "DENMoneyline"
      .replace(/([A-Za-z])(\$)/g, "$1 $2");
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
  /**
   * Stake and payout from a row's text. The matched part of the stake when the row shows it
   * ("Matched $15.00"), else the stake. Then: a labelled payout, a To Win figure, American odds,
   * or two amounts a multiplier apart.
   */
  const sizeIn = (raw) => {
    const text = spaced(raw);
    const wager = labelled(text, /(?:wager|stake|risk|cost|bet)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const matchedM = /(?:^|[^a-z])matched\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
    const matched = matchedM ? Number(matchedM[1].replace(/,/g, "")) : null;
    const stake = matched != null && matched > 0 && (wager == null || matched <= wager) ? matched : wager;
    const payout = labelled(text, /(?:payout|pays|returns|max\s*payout|total\s*return)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const toWin = labelled(text, /(?:to\s*win|to\s*gain|profit|win|gain)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const bare = noMoney(text);
    const odds = AMERICAN.exec(bare);
    // the venue can show the price as the implied chance (75.9%): payout per $1 is 100 over that
    const pct = PERCENT.exec(bare);
    const k = odds ? payoutMultiple(Number(odds[1])) : pct && Number(pct[1]) > 0 && Number(pct[1]) < 100 ? 100 / Number(pct[1]) : null;
    if (stake && payout && payout > stake) {
      // the payout on the row is for the whole stake; scale it to the matched part
      return sizeOf(stake, wager && stake < wager ? (payout * stake) / wager : payout);
    }
    if (stake && toWin) return sizeOf(stake, stake + (wager && stake < wager ? (toWin * stake) / wager : toWin));
    if (stake && k) return sizeOf(stake, stake * k);
    if (k) {
      // a table row carries bare amounts under column headers ("$20.00 74.68% $26.78"): the pair
      // the price joins, cost times payout-per-dollar equal to the payout, within a cent or two
      const amounts = amountsIn(text);
      for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && Math.abs(a * k - b) <= Math.max(0.05, 0.005 * b)) return sizeOf(a, b);
    }
    const mult = MULTIPLIER.exec(text);
    if (mult && Number(mult[1]) > 1) {
      const m = Number(mult[1]);
      const amounts = amountsIn(text);
      for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && Math.abs(b - a * m) <= Math.max(0.02, 0.01 * b)) return sizeOf(a, b);
      if (stake) return sizeOf(stake, stake * m);
    }
    return null;
  };
  /**
   * A table lays the row out under column headers (Cost, Price, Payout) instead of labelling each
   * figure. Pair the row's cells with the header cells by position and read the size from them.
   */
  const cellsOf = (row) => {
    const kids = [...row.children].filter((c) => !OURS(c));
    return kids.length >= 3 ? kids : null;
  };
  const headerCells = (row) => {
    const table = row.closest("table, [role=table], [role=grid], [role=treegrid]") || row.parentElement;
    if (!table) return null;
    const rows = [...table.querySelectorAll("thead tr, tr, [role=row]"), ...(row.parentElement ? row.parentElement.children : [])].filter((r) => r !== row && !r.contains(row) && !OURS(r));
    for (const r of rows) {
      const t = spaced(norm(r.textContent));
      if (/\$\s?\d/.test(t) || !/\b(cost|stake|wager|risk)\b/i.test(t) || !/\b(payout|to win|to gain|price|odds|return)\b/i.test(t)) continue;
      const cells = cellsOf(r);
      if (cells) return cells.map((c) => norm(c.textContent).toLowerCase());
    }
    return null;
  };
  const tableSize = (row) => {
    const cells = cellsOf(row);
    const heads = cells && headerCells(row);
    if (!heads || heads.length !== cells.length) return null;
    const at = (re) => {
      const i = heads.findIndex((h) => re.test(h));
      return i >= 0 ? spaced(norm(cells[i].textContent)) : "";
    };
    const money = (s) => amountsIn(s)[0] || null;
    const stake = money(at(/^(cost|stake|wager|risk|bet)\b/));
    if (!stake) return null;
    const payout = money(at(/^(payout|pays|return|total return)\b/));
    if (payout && payout > stake) return sizeOf(stake, payout);
    const gain = money(at(/^(to win|to gain|profit|win|gain)\b/));
    if (gain) return sizeOf(stake, stake + gain);
    const price = at(/^(price|odds)\b/);
    const odds = AMERICAN.exec(price);
    const pct = PERCENT.exec(price);
    const k = odds ? payoutMultiple(Number(odds[1])) : pct && Number(pct[1]) > 0 && Number(pct[1]) < 100 ? 100 / Number(pct[1]) : null;
    return k ? sizeOf(stake, stake * k) : null;
  };
  /** Winner (moneyline) or something else. A spread line is a signed one or two digit figure; American odds are three or more. */
  const kindIn = (raw) => {
    const text = spaced(raw);
    const bare = noMoney(text);
    if (/\b(spread|handicap|total|over|under|o\/u)\b/i.test(text) || /(^|\s)[+-]\d{1,2}(\.5)?(?=\s|$)/.test(bare)) return /\b(winner|moneyline|money line|ml)\b/i.test(text) ? "winner" : "other";
    return "winner";
  };
  /** Matched, or still an order. A row that says only Unmatched (no matched part, not partially matched) is an order. */
  const matchIn = (raw) => {
    const text = spaced(raw);
    const bare = noMoney(text);
    if (!/\b(unmatched|open order|resting|pending match)\b/i.test(bare)) return "matched";
    if (/\b(partially\s+matched|fully\s+matched|filled)\b/i.test(bare)) return "matched";
    const m = /(?:^|[^a-z])matched\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
    if (m) return Number(m[1].replace(/,/g, "")) > 0 ? "matched" : "unmatched";
    return /(^|[^a-z])matched\b/i.test(bare) ? "matched" : "unmatched";
  };
  /** The venue's play-money mode (points, not dollars) is never priced. */
  const pointsRow = (raw) => {
    const text = spaced(raw);
    return /\bprophet\s*points\b/i.test(text) || (/\bpts\b/i.test(text) && !/\$\s?\d/.test(text));
  };

  // ── finding the plays page and its rows ─────────────────────────────────────
  const onPortfolioPage = () => {
    // a hash-routed app is judged on its route, not on the file that hosts it
    const where = (location.hash.startsWith("#/") ? location.hash : location.pathname + " " + location.hash).toLowerCase();
    if (/portfolio|position|trades|my-?trades|open-?trades|plays|my-?plays|open-?plays|my-?bets|mybets|wagers|open-?bets|activity/.test(where)) return true;
    for (const h of document.querySelectorAll("h1, h2, h3, [role=heading]")) {
      if (OURS(h)) continue;
      if (/^(portfolio|positions|open positions|my trades|trades|open trades|my plays|plays|open plays|my bets|open bets|my wagers|active)\b/i.test(norm(h.textContent))) return true;
    }
    return false;
  };

  /**
   * Which list the page shows when it splits trades into tabs: resting orders, filled, settled.
   * The selected tab is the one marked so (aria, data-state, class), else the one drawn apart
   * from the others (lit text or an underline). Nothing decided means the rows speak for themselves.
   */
  const TAB_WORDS = /^(resting|open orders?|unmatched|pending|filled|matched|open|active|settled|closed|history)$/i;
  const tabGroup = (w) => (/^(resting|open orders?|unmatched|pending)$/i.test(w) ? "resting" : /^(settled|closed|history)$/i.test(w) ? "settled" : "filled");
  const MARKED = (el) => {
    for (let e = el, i = 0; e && i < 3; e = e.parentElement, i++) {
      if (e.getAttribute("aria-selected") === "true" || e.hasAttribute("aria-current") || e.getAttribute("data-state") === "active" || e.getAttribute("data-active") === "true") return true;
      if (/(^|[\s_-])(active|selected|current)(?![a-z])/i.test(e.className || "")) return true;
    }
    return false;
  };
  const tabState = (nodes) => {
    const tabs = [];
    for (const node of nodes) {
      const t = norm(node.nodeValue);
      if (t.length > 12 || !TAB_WORDS.test(t)) continue;
      // the tab is the outermost element that says only this word
      let el = node.parentElement;
      while (el.parentElement && el.parentElement !== document.body && norm(el.parentElement.textContent) === t) el = el.parentElement;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10 || r.height > 60) continue;
      tabs.push({ el, word: t.toLowerCase(), r });
    }
    const groups = new Set(tabs.map((x) => tabGroup(x.word)));
    if (groups.size < 2) return null;
    const marked = tabs.filter((x) => MARKED(x.el));
    if (marked.length === 1) return tabGroup(marked[0].word);
    if (marked.length > 1) return null;
    const styled = tabs.map((x) => {
      const cs = getComputedStyle(x.el);
      const rgb = (cs.color.match(/\d+/g) || [0, 0, 0]).slice(0, 3).map(Number);
      return { ...x, lum: (rgb[0] + rgb[1] + rgb[2]) / 3, line: parseFloat(cs.borderBottomWidth) > 0 && !/transparent|rgba\(0, 0, 0, 0\)/.test(cs.borderBottomColor), bold: parseInt(cs.fontWeight, 10) >= 600 };
    });
    const lined = styled.filter((x) => x.line);
    if (lined.length === 1) return tabGroup(lined[0].word);
    const bold = styled.filter((x) => x.bold);
    if (bold.length === 1 && styled.length > 1) return tabGroup(bold[0].word);
    const sorted = [...styled].sort((a, b) => b.lum - a.lum);
    if (sorted.length > 1 && sorted[0].lum - sorted[1].lum >= 60) return tabGroup(sorted[0].word);
    return null;
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
  const STAKE_LABELS = /(wager|stake|risk|cost|bet|payout|to\s*win|to\s*gain|pays)\s*:?\s*\$\s?\d/gi;
  const rowFrom = (node) => {
    let e = node.parentElement;
    let found = null;
    for (let i = 0; e && e !== document.body && i < 9; i++, e = e.parentElement) {
      if (e.querySelector("input, textarea")) break;
      const text = spaced(norm(e.textContent));
      if (text.length > 600) break;
      const r = e.getBoundingClientRect();
      if (r.height > 320 || r.width > window.innerWidth) break;
      const labels = (text.match(STAKE_LABELS) || []).length;
      if (found) {
        // a block was found without the row's stake and payout labels (a matched/unmatched detail
        // can carry two amounts on its own): keep climbing, within the same limits, to the ancestor
        // that has them; one row's worth of labels, never a list's
        if (labels > 2) break;
        if (labels >= 1) {
          found = e;
          break;
        }
        continue;
      }
      const amounts = amountsIn(text);
      const moneyWords = /\b(wager|stake|payout|to win|to gain|pays|returns|cost|avg|average|contracts|shares|risk|matched|odds)\b/i.test(text);
      if ((amounts.length >= 2 || (amounts.length >= 1 && moneyWords)) && r.width >= 200 && r.height >= 24) {
        found = e;
        if (labels >= 1) break;
      }
    }
    return found;
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
      const text = spaced(norm(row.textContent));
      if (pointsRow(text)) continue;
      const count = sidesIn(text);
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
        // one side named more often than any other; a side named once alone is the pick only when no
        // code in the row was left unresolved (else it may be the opponent of an unresolved pick)
        if ((sorted.length === 1 && (!count.ambiguous || sorted[0][1] >= 2)) || (sorted.length > 1 && sorted[0][1] > sorted[1][1])) ticker = sorted[0][0];
      }
      if (!ticker) {
        const withSvc = [...count.keys()].filter((t) => svcFor(t));
        if (withSvc.length === 1) ticker = withSvc[0];
      }
      if (!ticker) continue;
      // a spread or total row is never sized from the winner position the service holds on the same club;
      // an unmatched play is an order, so the service's confirmed position (if any) is a different play
      const kind = kindIn(text);
      // the page's tab decides what its rows are when the rows themselves do not say
      let match = matchIn(text);
      if (S.tab === "resting" && match === "matched") match = "unmatched";
      if (S.tab === "settled") match = "settled";
      const svc = kind === "winner" && match === "matched" ? svcFor(ticker) : null;
      const read = match === "matched" ? tableSize(row) || sizeIn(text) : null;
      out.push({ row, ticker, kind, match, size: svc ? { contracts: svc.contracts, entryCents: svc.entryCents, stakeCents: svc.costCents, payoutCents: svc.payoutCents } : read, from: svc ? "service" : read ? "page" : "none" });
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
    // in a table our cell already spans every column; sizing it to the row would widen the table,
    // which widens the row, which would size it again
    if (B.host.tagName === "TR") return;
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
        return { why: "Protection covers the Moneyline market.", next: "A Moneyline pick on this game can be locked in." };
      case "unmatched":
        return { why: "This play has not been matched yet.", next: "It is an order until another account takes the other side. Protection prices on the matched stake; check back once it fills." };
      case "settled":
        return { why: "This play has settled.", next: "Protection is for plays on games that have not started." };
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
      else line = lineGo("Protected &middot; " + esc(usd(rs.floorTotal)) + " or " + esc(usd(rs.capTotal)), "whichever way it goes &middot; +" + esc(usd(rec.creditCents)) + " paid &middot; details", "ael-line-on");
    } else if (B.kind === "other") {
      line = lineGo("Protection unavailable", "covers Moneyline picks", "ael-line-off");
    } else if (B.match === "unmatched") {
      line = lineGo("Protection unavailable", "waits until the play is matched", "ael-line-off");
    } else if (B.match === "settled") {
      line = lineGo("Protection unavailable", "this play has settled", "ael-line-off");
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
      const was = B.size && B.size.payoutCents ? " (was " + esc(usd(B.size.payoutCents)) + ")" : "";
      line = lineGo("Lock in &middot; " + esc(usd(rs.floorTotal)) + " if the " + esc(shortOf(B.ticker)) + " lose", "instead of $0 &middot; " + esc(usd(rs.capTotal)) + " if they win" + was + " &middot; +" + esc(usd(t.creditCents)) + " paid now", "");
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
    if (B.match === "unmatched") return paintRefusal(B, panel, "unmatched", "");
    if (B.match === "settled") return paintRefusal(B, panel, "settled", "");
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
      '<div class="ael-tiles"><div class="ael-tile ael-k"><div class="ael-l">if ' + esc(shortOf(B.ticker)) + ' lose</div><div class="ael-v">' + esc(usd(rs.floorTotal)) + '</div><div class="ael-was">was $0</div></div>' +
      '<div class="ael-tile"><div class="ael-l">paid now</div><div class="ael-v">+' + esc(usd(t.creditCents)) + '</div><div class="ael-was">yours today</div></div>' +
      '<div class="ael-tile"><div class="ael-l">if they win</div><div class="ael-v">' + esc(usd(rs.capTotal)) + '</div><div class="ael-was">was ' + esc(was) + "</div></div></div>" +
      (seg ? '<div class="ael-segs">' + seg + "</div>" : "") +
      '<button type="button" class="ael-go" id="ael-go-' + esc(B.ticker) + '">Lock in &middot; worst case ' + esc(usd(rs.floorTotal)) + "</button>" +
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
    panel.innerHTML = '<div class="ael-ph"><b>' + esc(w.why) + "</b>" + (w.next ? "<span>" + esc(w.next) + "</span>" : "") + "</div>" + sizeForm + '<div class="ael-fine">' + (code === "spread" || code === "no_size" || code === "unmatched" ? "" : "Protection is offered when the market pays for it. ") + '<a href="#" class="ael-close-a">close</a></div>' + DISCLOSE;
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
    c.innerHTML = '<div class="ael-card-h"><span>Your plays &middot; protection</span><button type="button" class="ael-x" aria-label="Hide">&times;</button></div><div class="ael-card-b"></div>';
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
        B = { row: item, host: item, box: item.querySelector(".ael-row"), ticker: p.ticker || "__" + p.id, kind: "winner", match: "matched", size: { contracts: p.contracts, entryCents: p.entryCents, stakeCents: p.costCents, payoutCents: p.payoutCents }, from: "service", card: true };
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
    const nodes = textNodes();
    S.tab = tabState(nodes);
    const found = findRows(nodes);
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
        B.match = F.match;
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
  if (window.__AEL_DEBUG) {
    window.__ael = S;
    window.__aelFns = { sidesIn, rowFrom, findRows, textNodes, tableSize, sizeIn, tabState };
  }
})();
