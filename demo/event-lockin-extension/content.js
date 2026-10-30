// Atticus Earn & Protect: Lock in (content script).
//
// One place, after the trade. On the venue's My Trades page (its list of open plays), each open
// matched play the engine can protect gets one line directly under its row: "Lock in · +$0.60 now"
// with the worst case it buys. Tap it and our panel opens inline under that row, pushing the rows
// below down; nothing floats over the venue's page. Plays we cannot protect get the same line
// muted, and the tap says why. A locked play shows a Protected chip whose details are the four
// things a holder needs: worst case, best case, what was paid, when it settles, and the public record.
//
// Before the trade, two quiet things and no more: a small shield after the name of each club whose
// game the service can protect this week (game list, game page), and one line in the order slip
// once a Winner pick sits in it, with the floor at the slip's stake. No button before the trade.
// The venue's own flow places the play; protection is locked on what the account then holds.
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
// Venues: one script, three skins. ProphetX (My Trades, prices as the implied chance or American
// odds), Kalshi (Portfolio, Yes/No contracts priced in cents; a No on one club is read as the
// other club's Yes) and Novig (Portfolio, decimal multipliers, Take fills now and Make rests).
// The host name picks the venue; it sets the colours, the words and the reading rules below.
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
  // a row still on the page that one scan could not read keeps its block this long before it is dropped
  const ROW_GRACE_MS = 6_000;
  // the three shapes the service prices, shown only when the book offers more than one
  // the shapes, the most upside first: that is the one the service heads the quote with, and the
  // one a trader reaches for. Each is named for what it gives, never for what it costs
  const TIER_ORDER = ["wide", "balanced", "tight"];
  const TIER_WORDS = { wide: "Max upside", balanced: "Balanced", tight: "Max floor" };
  const DEFAULTS = { showHedge: "no", rehearse: "no", showShield: "yes", showSlip: "yes", telemetry: "yes", layout: "simple" };

  // ── the venue this page belongs to ──────────────────────────────────────────
  // One codebase, three skins. The host name decides; a preview page names its venue in a meta
  // tag. The venue sets the colours (a class on every root we draw), the word for a play, and a
  // few reading rules: Kalshi prices in cents and counts contracts, with a Yes and a No side on
  // each club; Novig prices as multipliers (1.25x) and rests a Make order until it is taken.
  const VENUES = {
    prophetx: { name: "ProphetX", host: /(^|\.)prophetx\.(co|dev)$/, play: "play", plays: "plays", page: "My Trades", matched: "matched" },
    kalshi: { name: "Kalshi", host: /(^|\.)kalshi\.com$/, play: "position", plays: "positions", page: "Portfolio", matched: "filled" },
    novig: { name: "Novig", host: /(^|\.)novig\.(us|com)$/, play: "order", plays: "orders", page: "Portfolio", matched: "matched" },
  };
  const detectVenue = () => {
    const host = String(location.hostname || "").toLowerCase();
    for (const id of Object.keys(VENUES)) if (VENUES[id].host.test(host)) return id;
    const meta = document.querySelector('meta[name="ael-venue"]');
    if (meta && VENUES[meta.getAttribute("content")]) return meta.getAttribute("content");
    // the stand-in boards, and saved copies of the real pages dropped in preview/fixtures/<venue>-*.html
    const m = /\/preview\/(?:fixtures\/)?(prophetx|kalshi|novig)[-.]/i.exec(location.pathname);
    return m ? m[1].toLowerCase() : "prophetx";
  };
  const VENUE_ID = detectVenue();
  const V = VENUES[VENUE_ID];
  /** The class every root we draw carries, so the skin's variables cascade into it. */
  const SKIN = "ael-v-" + VENUE_ID;

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
    svcSize: new Map(), // ticker -> the last position the service confirmed on it, kept through a read that misses it
    record: new Map(), // ticker -> the public record's lock position (open or settled)
    rows: new Map(), // row element -> binding { row, host, ticker, size, kind, from }
    st: new Map(), // ticker -> { quote, quoteAt, quoteKey, tier, open, how, busy, done }
    pageOk: false,
    serviceState: "loading",
    lastScan: 0,
    cardRows: new Map(), // position id -> binding (fallback card)
    pills: new Map(), // game stem -> { el, html }: the pill on each protectable game's card
    tip: null, // the hover card open over a pill
    slip: null, // the order slip's binding while a protectable pick sits in it
    ext: {}, // the service's switches for the extension: minVersion, marksOff, cutoffMinutes
    counts: { games: 0, marks: 0, slip: 0, slipMarked: 0, rows: 0, offers: 0, unread: 0 },
    tele: { key: null, timer: null },
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
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
  /**
   * Money on a size. A size is contracts to the hundredth (Kalshi sells fractions; a $7.69 payout
   * is 7.69 contracts), so a per-contract figure times it can land on a half cent. The service's
   * rule, mirrored here so the slip and the record agree: a payout line rounds half up; the
   * funding the cap releases (what is handed back on a win) rounds down, and the cap total is the
   * whole payout less that, so handback + kept = payout + credit to the cent.
   */
  const hundredths = (n) => Math.round(n * 100);
  const centsOf = (per, n) => Math.round((per * hundredths(n)) / 100);
  const centsDownOf = (per, n) => Math.floor((per * hundredths(n)) / 100);
  /** The holder's two outcomes on this row under terms (floor, cap, credit) on n contracts. */
  const outcomes = (B, n, F, C, K) => ({ floorTotal: centsOf(F, n) + K, capTotal: centsOf(100, n) - centsDownOf(100 - C, n) + K });
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
  /**
   * An element's text without ours. Under a card our block sits inside the card (see
   * insertionPoint), so the card's textContent would carry our own words and figures: "Knicks
   * lose $6.95" would be read back as a second name and a third amount.
   */
  const pageText = (e) => {
    if (!e.querySelector(".ael-ui")) return e.textContent;
    let out = "";
    const w = document.createTreeWalker(e, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (OURS(n) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) });
    while (w.nextNode()) out += w.currentNode.nodeValue;
    return out;
  };
  /**
   * The page's own height of a block: the extent of its children that are not ours, never its box.
   * The box lies two ways. A card in a deck is stretched to the tallest card on its line (a flex
   * row's default), so when our panel opens inside one card every card beside it grows with it;
   * and a card that holds our block is taller by our block and its margin. Either would read a
   * position as a page-sized block and drop its line. A block with no element children is its box.
   */
  const pageHeight = (e, r) => {
    let top = Infinity;
    let bottom = -Infinity;
    for (const c of e.children) {
      if (c.classList.contains("ael-ui")) continue;
      const cr = c.getBoundingClientRect();
      if (!cr.height && !cr.width) continue;
      if (cr.top < top) top = cr.top;
      if (cr.bottom > bottom) bottom = cr.bottom;
    }
    if (top === Infinity) return r.height;
    return Math.min(r.height, bottom - top);
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
  /** The game a market belongs to: the ticker without its side (KXNBAGAME-26OCT27DETNYK). */
  const stemOf = (ticker) => String(ticker || "").slice(0, String(ticker || "").lastIndexOf("-"));
  /**
   * The other club of a market's game, by nickname: the matchup in the ticker (DETNYK) less the
   * market's own code (NYK), looked up in the market's league. Null when the stem does not parse.
   */
  const opponentOf = (ticker) => {
    const m = S.byTicker[ticker];
    const part = /\d{2}[A-Z]{3}\d{2}([A-Z]+)$/.exec(stemOf(ticker));
    if (!m || !part) return null;
    const code = codeOf(ticker);
    const pair = part[1];
    const rest = pair.startsWith(code) ? pair.slice(code.length) : pair.endsWith(code) ? pair.slice(0, -code.length) : null;
    return rest ? (NICK[String(m.league || "").toLowerCase()] || {})[rest] || null : null;
  };
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  /**
   * One ticker out of several the same name fits. A club plays every week, so once the holder's
   * locks are indexed beside the live markets, "Colts" can name last Sunday's lock and next
   * Sunday's game at once. The game day settles it: the ticker carries it (26OCT18, Eastern) and
   * the venue prints it on the row. A text with no date falls to the tab: Settled wants a lock
   * that has settled, the other tabs want a market the holder can still act on.
   */
  const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  const DATE_RE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b|\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/gi;
  /** The game day in a ticker (KXNFLGAME-26OCT25KCSEA-KC) or a stem (KXNFLGAME-26OCT25KCSEA): [yy, month 1-12, day], or null. */
  const dayParts = (s) => {
    const m = /-(\d{2})([A-Z]{3})(\d{2})[A-Z]+(?:-[A-Z]+)?$/.exec(String(s || ""));
    const mo = m ? MONTHS.indexOf(m[2]) : -1;
    return mo >= 0 ? [Number(m[1]), mo + 1, Number(m[3])] : null;
  };
  const gameDayOf = (ticker) => {
    const d = dayParts(ticker);
    return d ? d[1] + "-" + d[2] : null;
  };
  /** The game day as a number that sorts (yymmdd from the ticker's 26OCT25), unknown last. */
  const gameOrdinal = (ticker) => {
    const d = dayParts(ticker);
    return d ? d[0] * 10000 + d[1] * 100 + d[2] : Infinity;
  };
  /** The game day as a date at noon Eastern (the ticker's day is Eastern), for its weekday and the day after. */
  const gameDate = (s, plusDays) => {
    const d = dayParts(s);
    return d ? new Date(Date.UTC(2000 + d[0], d[1] - 1, d[2] + (plusDays || 0), 16)) : null;
  };
  const dayKey = (date) => {
    const [mo, day] = date.toLocaleDateString("en-US", { month: "numeric", day: "numeric", timeZone: "America/New_York" }).split("/");
    return Number(mo) + "-" + Number(day);
  };
  /**
   * Does a printed date name this game? The ticker's day, or the day after it: a venue that prints
   * in UTC puts a 10pm Eastern tip on the next date. Nothing else does; a row dated Oct 19 is not a
   * pick on the Nov 1 game, whatever club it names.
   */
  const dayMatches = (ticker, days) => days.has(gameDayOf(ticker)) || (gameDate(ticker, 1) ? days.has(dayKey(gameDate(ticker, 1))) : false);
  const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  const WEEKDAY_RE = /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/gi;
  /** The weekdays a text names, as the three-letter words. */
  const weekdaysIn = (text) => {
    const out = new Set();
    let m;
    WEEKDAY_RE.lastIndex = 0;
    while ((m = WEEKDAY_RE.exec(text))) out.add(m[1].slice(0, 3).toLowerCase());
    return out;
  };
  const weekdayOf = (s) => {
    const d = gameDate(s);
    return d ? WEEKDAYS[d.getUTCDay()] : null;
  };
  const TODAY_RE = /\b(today|tonight)\b/i;
  const TOMORROW_RE = /\btomorrow\b/i;
  /**
   * The moment a bet was placed is not the game's day. Novig stamps every card "Placed: Wed 11:33PM",
   * Kalshi "placed Oct 27 · 12:48 PM": a weekday or date right after such a word is the order's, and
   * reading it as the game's picked the Cavaliers' Wednesday game for a card on their Thursday one.
   */
  const PLACED_RE = new RegExp(
    "\\b(?:placed|wagered|accepted|created|opened)\\b:?\\s*(?:on\\s+|at\\s+)?" +
      "(?:(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\\.?,?\\s*)?" +
      "(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?\\s+\\d{1,2}(?:,?\\s*\\d{4})?|\\d{1,2}\\/\\d{1,2}(?:\\/\\d{2,4})?)?" +
      "\\s*(?:[\\u00b7@,]|at)?\\s*(?:\\d{1,2}:\\d{2}\\s*(?:[ap]\\.?m\\.?)?)?",
    "gi",
  );
  /** The text with its placement stamps taken out: what is left names the game. */
  const gameWords = (text) => String(text).replace(PLACED_RE, " ");
  /** The games on the venue's "today" or "tomorrow": the day exactly, else the one whose late tip a UTC venue prints on the next date. */
  const onRelativeDay = (list, text) => {
    if (!TODAY_RE.test(text) && !TOMORROW_RE.test(text)) return [];
    const key = dayKey(new Date(Date.now() + (TOMORROW_RE.test(text) ? 86_400_000 : 0)));
    const exact = list.filter((t) => gameDayOf(t) === key);
    return exact.length ? exact : list.filter((t) => dayMatches(t, new Set([key])));
  };
  const UNDER_WAY_RE = /\b(live|in progress|started|final|q[1-4]|[1-4](?:st|nd|rd|th) (?:quarter|half|inning)|halftime|ot)\b/i;
  const CLOCK_RE = /\b\d{1,2}:\d{2}\s?(?:[ap]\.?m\.?)?\b/i;
  const datesIn = (text, namedOnly) => {
    const out = new Set();
    let m;
    DATE_RE.lastIndex = 0;
    while ((m = DATE_RE.exec(text))) {
      // "5/2" may be odds or a count; only a month's name is a date for sure
      if (namedOnly && !m[1]) continue;
      const mo = m[1] ? MONTHS.indexOf(m[1].slice(0, 3).toUpperCase()) + 1 : Number(m[3]);
      const day = Number(m[2] || m[4]);
      if (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) out.add(mo + "-" + day);
    }
    return out;
  };
  const choose = (tickers, raw) => {
    const list = [...new Set(tickers)];
    if (!list.length) return null;
    const text = gameWords(raw);
    // a row that prints a game day names that game or none: a club's only listed game is not the
    // pick on a row dated three weeks earlier (the Oct 19 Texans row and the Nov 1 Jaguars game)
    const days = datesIn(text, list.length === 1);
    if (days.size) {
      const dated = list.filter((t) => dayMatches(t, days));
      return dated.length === 1 ? dated[0] : null;
    }
    if (list.length === 1) return list[0];
    // the venue's own word for the game day ("8:05 PM Today") outranks a weekday printed elsewhere on the card
    const rel = onRelativeDay(list, text);
    if (rel.length === 1) return rel[0];
    // a weekday on the row ("7:00 PM Thu") names the game on that weekday, or the one that tips
    // late enough to print on the next day, as the board's own game chooser reads it
    const wds = weekdaysIn(text);
    if (wds.size) {
      const onDay = list.filter((t) => {
        const next = gameDate(t, 1);
        return wds.has(weekdayOf(t)) || (next && wds.has(WEEKDAYS[next.getUTCDay()]));
      });
      if (onDay.length === 1) return onDay[0];
    }
    if (!S.pageOk) {
      // before the trade, a club named without a date: on a game's own page, that game; on a
      // board, the club's next game (the week in view), the page's own date deciding when it prints one
      if (S.counts.games === 1) {
        const onPage = list.filter((t) => S.pills.has(t.slice(0, t.lastIndexOf("-"))));
        if (onPage.length === 1) return onPage[0];
      }
      const sorted = [...list].sort((a, b) => gameOrdinal(a) - gameOrdinal(b));
      return gameOrdinal(sorted[0]) < gameOrdinal(sorted[1]) ? sorted[0] : null;
    }
    // a lock left early is still the venue's live position (the pick is the holder's to sell), so the
    // active tabs keep it; only the game's own settlement moves it to the settled tab
    const settledLock = (t) => {
      const r = S.record.get(t);
      return Boolean(r && (r.status === "settled" || r.status === "void"));
    };
    const byTab = S.tab === "settled" ? list.filter(settledLock) : list.filter((t) => !settledLock(t));
    return byTab.length === 1 ? byTab[0] : null;
  };

  /**
   * The sides a row can name: the markets the service can protect this week, and the holder's
   * own locks. The service lists live markets only, so a locked game drops off the list when it
   * settles; without its lock in the index the settled row could not be tied to its record and
   * would read as never protected.
   */
  const indexMarkets = (markets) => {
    S.markets = markets;
    S.byTicker = {};
    S.nicks = new Map();
    S.codes = new Map();
    const locks = [...S.record.values()].filter((p) => p.ticker && p.league && !markets.some((m) => m.ticker === p.ticker));
    for (const m of [...markets, ...locks]) {
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
  /** Every club the tables know, listed or not, as one pattern: what a row names when the service lists no game for it. */
  const ALL_NICK_RE = (() => {
    const all = [...new Set(Object.values(NICK).flatMap((t) => Object.values(t)))].map((n) => n.toLowerCase()).sort((a, b) => b.length - a.length).map(escapeRe);
    return new RegExp("(^|[^a-z0-9])(" + all.join("|") + ")(?![a-z0-9])", "ig");
  })();
  /** nickname (lower case) -> times named, over every club the tables know. */
  const clubsNamed = (text) => {
    const out = new Map();
    let m;
    ALL_NICK_RE.lastIndex = 0;
    while ((m = ALL_NICK_RE.exec(text))) {
      const k = m[2].toLowerCase();
      out.set(k, (out.get(k) || 0) + 1);
    }
    return out;
  };
  /** The clubs a text names that the service lists no game for (and the holder holds no lock on). */
  const unlistedNamed = (text) => new Map([...clubsNamed(text)].filter(([k]) => !S.nicks.has(k)));
  /**
   * Is the text's pick, the club it names more than any other, one the service lists no game for?
   * Such a row is not protected; reading it as a pick on the opponent (whose next game is listed)
   * would price the wrong game. A text naming its clubs equally often decides nothing here.
   */
  const unlistedPick = (text) => {
    const sorted = [...clubsNamed(text).entries()].sort((a, b) => b[1] - a[1]);
    if (!sorted.length || (sorted.length > 1 && sorted[0][1] === sorted[1][1])) return false;
    return !S.nicks.has(sorted[0][0]);
  };

  /**
   * The service's markets, retried on failure. The service sleeps between demos and takes up to a
   * minute to wake, and the first call from a fresh tab is the one that finds it asleep: a failed
   * load tries again at 3s, 8s, 20s and 45s before the five-minute poll takes over, and the
   * notice says the service is waking rather than unreachable until those are spent. A reload of
   * the extension itself invalidates this script's runtime (every call then fails the same way);
   * that is told apart and the notice asks for a page reload instead of retrying forever.
   */
  const RETRY_MS = [3_000, 8_000, 20_000, 45_000];
  let marketsRetry = null;
  const runtimeGone = (r) => /context invalidated|Extension context/i.test(String((r && r.error) || "")) || !(chrome.runtime && chrome.runtime.id);
  const loadMarkets = async () => {
    if (S.serviceState === "gone") return;
    const r = await api("/api/shadow/markets", "GET");
    if (r.ok && r.json && r.json.ok && Array.isArray(r.json.markets)) {
      indexMarkets(r.json.markets);
      S.ext = r.json.ext && typeof r.json.ext === "object" ? r.json.ext : {};
      // a service built before `ext` has no telemetry route and no word on windows: draw as 0.6 did
      S.ext.legacy = !(r.json.ext && typeof r.json.ext === "object");
      // the service names the oldest build it will draw with; an older one shows only the notice
      S.serviceState = S.ext.minVersion && cmpVersion(EXT_VERSION, S.ext.minVersion) < 0 ? "old" : "ok";
      S.marketsTries = 0;
    } else if (runtimeGone(r)) {
      S.serviceState = "gone";
    } else {
      S.serviceState = r.status === 403 ? "key" : r.status === 404 ? "off" : "down";
      S.marketsTries = (S.marketsTries || 0) + 1;
      S.downDetail = r.status ? "HTTP " + r.status : r.error || "";
      if (S.serviceState === "down" && S.marketsTries <= RETRY_MS.length && !marketsRetry) {
        marketsRetry = setTimeout(() => {
          marketsRetry = null;
          void loadMarkets();
        }, RETRY_MS[S.marketsTries - 1]);
      }
    }
    scan(true);
  };

  /**
   * A lock as the service now reports it, keeping what only the tap knew: that it was this
   * moment, how long it took, the hedge behind it. The refreshes carry none of that, and a panel
   * whose words change under the holder a few seconds after the tap reads as a glitch.
   */
  /**
   * The record's lock on this market as this page's own. A lock belongs to the venue it was made
   * from (`holderVenue` on the record; a lock written without one is Kalshi's, the service's
   * default): it protects the holder's pick there and nowhere else, so the same game held on
   * another venue is not it. `lockAway` is an open lock on another venue, which bars this one
   * (one lock per game); a lock closed or settled elsewhere says nothing here.
   */
  const venueOfLock = (r) => String((r && r.holderVenue) || "kalshi").toLowerCase();
  const lockHere = (ticker) => {
    const r = S.record.get(ticker);
    return r && venueOfLock(r) === VENUE_ID ? r : null;
  };
  const lockAway = (ticker) => {
    const r = S.record.get(ticker);
    return r && venueOfLock(r) !== VENUE_ID && r.status === "open" ? r : null;
  };
  /**
   * A lock here whose protection was removed, on a game the service offers again (`onRecord` false
   * on the market once the service frees a market left early): the row goes back to the offer, and
   * the removed lock is a grey line on it. A service that still holds the market keeps the row on
   * Protection removed, so a tap can never meet "already locked".
   */
  const removedHere = (ticker, rec) => {
    const r = rec || lockHere(ticker);
    // a rehearsed leave stays on Protection removed until Reset; the service never held the market
    if (!r || r.status !== "closed" || r.rehearsal) return null;
    const m = S.byTicker[ticker];
    return m && m.onRecord === false ? r : null;
  };
  const venueNameOf = (id) => (VENUES[id] && VENUES[id].name) || (id === "polymarket" ? "Polymarket" : String(id || ""));

  const rememberLock = (ticker, next) => {
    const prev = S.record.get(ticker);
    // the tap's own answers (the hedge, the routing, the sale at the leave) are kept: the public record carries none of them
    S.record.set(ticker, prev ? { ...next, justNow: Boolean(prev.justNow), justLeft: Boolean(prev.justLeft), ms: prev.ms, hedge: next.hedge || prev.hedge || null, routing: next.routing || prev.routing || null, closeHedge: next.closeHedge || prev.closeHedge || null } : next);
    // a lock on a game the service no longer lists joins the index so its row is still found
    if (!S.byTicker[ticker] && next.league) indexMarkets(S.markets);
  };

  /** The service's confirmation of what the account holds, when it has a read key. */
  const loadPositions = async () => {
    const r = await api("/api/shadow/positions", "GET");
    if (r.ok && r.json && r.json.ok) {
      S.svc = { configured: Boolean(r.json.configured), positions: Array.isArray(r.json.positions) ? r.json.positions : [], at: Date.now(), error: null };
      // a read on which the venue described every market is the whole truth (a sold position is
      // gone from it); one on which a lookup failed adds to what earlier reads confirmed
      if (S.svc.positions.every((p) => p.reason !== "market_lookup_failed")) S.svcSize.clear();
      for (const p of S.svc.positions) {
        if (p.ticker) S.svcSize.set(p.ticker, p);
        if (p.ticker && p.lock) rememberLock(p.ticker, { ...p.lock, ticker: p.ticker, fromSvc: true });
      }
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
      for (const p of list) if (p && p.source === "lock" && p.ticker) rememberLock(p.ticker, p);
    }
    scan(true);
  };

  /**
   * Every side the text names, with how often; the pick is named more than once on most rows.
   * A side is a nickname ("Colts", "IND Colts") or, where the venue prints only codes ("NYJ @ NE"),
   * a bare upper-case code that names exactly one market the service can protect this week.
   */
  const CODE_RE = /(^|[^A-Za-z0-9])([A-Z]{2,3})(?![A-Za-z0-9])/g;
  /**
   * Two team codes joined as a matchup, as a board with no nicknames prints its cards: "BKN at
   * BOS"; "DET DET at 3-0 NYK NYK" (each code twice, badge and label, a record between); "SA SAS
   * at NYK" (two spellings of one club). Groups: away code, its second spelling, home code, its second spelling.
   */
  const MATCHUP_RE = /(^|[^A-Za-z0-9])([A-Z]{2,3})(?:\s+([A-Z]{2,3}))?(?:\s+\d{1,2}-\d{1,2})?\s+(?:at|vs\.?|@)\s+(?:\d{1,2}-\d{1,2}\s+)?([A-Z]{2,3})(?:\s+([A-Z]{2,3}))?(?![A-Za-z0-9])/g;
  const LEAGUE_WORDS = [
    [/\b(nfl|pro fb|football)\b/i, "nfl"],
    [/\b(nba|pro bb|basketball)\b/i, "nba"],
    [/\b(mlb|pro bsb|baseball)\b/i, "mlb"],
  ];
  const leagueOf = (ticker) => String((S.byTicker[ticker] || {}).league || "").toLowerCase();
  const sidesIn = (raw) => {
    const text = spaced(raw);
    const out = nicksIn(text);
    out.ambiguous = Boolean(out.ambiguous);
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
      // one club, several weeks (IND last Sunday's lock, IND next Sunday's game): the row's date or
      // the tab, else the one game it shares with a side already read ("DET at NYK")
      let one = pick.length === 1 ? pick[0] : choose(pick, text);
      if (!one) {
        // the one game this code shares with another code on the row, resolved or not: a card that
        // prints only "CLE … ATL" names the Cavaliers at the Hawks, the game both codes can mean,
        // not the Browns' or the Falcons' Sunday (the week lists all four)
        const stems = new Set([...out.keys()].map(stemOf));
        for (const other of found) if (other !== list) for (const t of other) stems.add(stemOf(t));
        const shared = pick.filter((t) => stems.has(stemOf(t)));
        if (shared.length === 1) one = shared[0];
      }
      if (one) out.set(one, (out.get(one) || 0) + 1);
      else out.ambiguous = true;
    }
    return out;
  };
  const nicksIn = (raw) => {
    const text = spaced(raw);
    const out = new Map();
    if (!S.nickRe) return out;
    const deferred = [];
    let m;
    S.nickRe.lastIndex = 0;
    while ((m = S.nickRe.exec(text))) {
      let list = S.nicks.get(m[2].toLowerCase()) || [];
      if (list.length > 1) {
        // a code just before the name ("IND Colts") narrows a nickname two leagues share
        const before = text.slice(0, m.index + m[1].length).trim();
        const code = /(?:^|[^A-Za-z])([A-Z]{2,3})$/.exec(before);
        if (code) {
          const hit = list.filter((x) => x.code === code[1] || (CODE_ALIAS[code[1]] || []).includes(x.code));
          if (hit.length) list = hit;
        }
      }
      // the same club across weeks: the game day on the row, else the tab, else the matchup below
      const ticker = choose(list.map((x) => x.ticker), text);
      if (ticker) out.set(ticker, (out.get(ticker) || 0) + 1);
      else deferred.push({ key: m[2].toLowerCase(), tickers: list.map((x) => x.ticker) });
    }
    // a club with several listed games and nothing on the row to pick one ("NY Knicks", three
    // games this week) is settled by the matchup: the one game it shares with another club the
    // text names ("DET Pistons vs NY Knicks" is Oct 27 and no other), or with a side already read
    for (const d of deferred) {
      const others = new Set([...out.keys()].map(stemOf));
      for (const o of deferred) if (o.key !== d.key) for (const t of o.tickers) others.add(stemOf(t));
      const shared = [...new Set(d.tickers.filter((t) => others.has(stemOf(t))))];
      if (shared.length === 1) out.set(shared[0], (out.get(shared[0]) || 0) + 1);
      else out.ambiguous = true;
    }
    return out;
  };

  // ── reading sizes off a row (fallback when the service has no key) ──────────
  const MONEY = /\$\s?(\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?)/g;
  /** The text without its dollar amounts. Cells can touch ("$20.0074.68%"), so only an amount's own shape is removed, never the digits after it. */
  const noMoney = (text) => text.replace(/\$\s?\d{1,6}(?:,\d{3})*(?:\.\d{1,2})?/g, " ");
  // a venue's reference for the play ("ID: a49b5764ac7c") is not a figure: its hex can end in a
  // digit and a c, which reads as a price in cents once the letters and digits are spaced apart
  const noIds = (text) => String(text).replace(/(^|[^A-Za-z]|[a-z](?=ID))(?:[Ii][Dd]|[Rr]ef(?:erence)?|[Tt]icket)\s*:?\s*#?\s*(?=[A-Za-z0-9-]*\d)[A-Za-z0-9-]{6,}/g, "$1 ");
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
      .replace(/([A-Za-z])(\d)/g, "$1 $2") // "SEA1.71x": a code then the price in the next element
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2") // "DENMoneyline"
      .replace(/([A-Za-z])(\$)/g, "$1 $2")
      .replace(/\b([AP]M)([A-Z]{2,3})(?![A-Za-z0-9])/g, "$1 $2") // "7:00 PMATL": a clock then the next code
      .replace(/(^|[^A-Za-z0-9])([A-Z]{2,3})\2(?![A-Za-z0-9])/g, "$1$2 $2"); // "CLECLE": a jersey's letters run into the label beside it
  const amountsIn = (text) => {
    const out = [];
    let m;
    MONEY.lastIndex = 0;
    while ((m = MONEY.exec(text))) out.push(Number(m[1].replace(/,/g, "")));
    return out;
  };
  /**
   * A size: what the position pays and cost, to the cent, as the venue prints them, and the
   * contracts the lock covers: one $1 contract per payout dollar, to the hundredth, so the whole
   * position is covered (15.95 contracts on Kalshi, 7.69 for a $7.69 payout elsewhere). A position
   * under one contract has no size.
   */
  const sizeOf = (stake, payout) => {
    const contracts = Math.round(payout * 100) / 100;
    if (contracts < 1) return null;
    return {
      contracts,
      entryCents: Math.min(99, Math.max(1, Math.round((100 * stake) / payout))),
      stakeCents: Math.round(stake * 100),
      payoutCents: Math.round(payout * 100),
    };
  };
  // Kalshi's units are ours: N contracts at c cents each pay $N. A price in cents ("42¢", "@ 42c",
  // "Avg 62.67¢") and a contract count ("10 contracts", "15.95 shares"), or the price and the cost.
  const CENTS = /(?:^|[^\d.$])(\d{1,2}(?:\.\d+)?)\s?(?:¢|&cent;|c(?![a-z0-9]))/i;
  const CONTRACTS = /(\d{1,6}(?:,\d{3})*(?:\.\d+)?)\s*(?:contracts?|shares?)\b/i;
  const sizeOfContracts = (held, cents, costCents) => {
    const contracts = Math.round(held * 100) / 100;
    if (contracts < 1) return null;
    return {
      contracts,
      entryCents: Math.min(99, Math.max(1, Math.round(cents))),
      stakeCents: costCents != null ? costCents : Math.round(held * cents),
      payoutCents: Math.round(held * 100),
    };
  };
  const centsSize = (text) => {
    const bare = noMoney(text);
    const c = CENTS.exec(bare);
    const cents = c ? Number(c[1]) : null;
    const n = labelled(text, CONTRACTS);
    if (cents && cents > 0 && cents < 100) {
      if (n) return sizeOfContracts(n, cents);
      const amounts = amountsIn(text);
      // the cost at that price: contracts are the cost over the price
      const cost = labelled(text, /(?:cost|paid|spent|total|amount|avg\s*cost)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i) || amounts[0];
      // no count printed: the contracts the cost buys at that price, to the hundredth
      if (cost) return sizeOfContracts(Math.round((10_000 * cost) / cents) / 100, cents, Math.round(cost * 100));
    }
    if (n) {
      const cost = labelled(text, /(?:cost|paid|spent|amount)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
      if (cost && cost < n) return sizeOfContracts(n, (100 * cost) / n);
    }
    return null;
  };
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
    const text = spaced(noIds(raw));
    // Kalshi says it in our units outright; read those before any dollar pairing
    if (VENUE_ID === "kalshi") {
      const k = centsSize(text);
      if (k) return k;
    }
    const wager = labelled(text, /(?:wager|stake|risk|cost|bet|amount)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
    const matchedM = /(?:^|[^a-z])matched\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
    const matched = matchedM ? Number(matchedM[1].replace(/,/g, "")) : null;
    const stake = matched != null && matched > 0 && (wager == null || matched <= wager) ? matched : wager;
    // Novig's card labels the two figures Amount and To Pay
    const payout = labelled(text, /(?:payout|pays|to\s*pay|returns|max\s*payout|total\s*return)\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i);
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
      // a venue that nets its fee out of the winnings prints a payout a little under stake times
      // the multiplier ($20 at 1.25x pays $24.70, not $25.00): the pair whose profit is most of it
      for (const a of amounts) for (const b of amounts) if (a > 0 && b > a && b <= a * m + 0.02 && b - a >= 0.85 * (a * m - a)) return sizeOf(a, b);
      if (stake) return sizeOf(stake, stake * m);
    }
    return centsSize(text);
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
      // a sortable header carries its arrow in the text ("↑Cost"); the word is what is matched
      if (cells) return cells.map((c) => norm(c.textContent).toLowerCase().replace(/^[^a-z0-9$]+/, ""));
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
    // Kalshi's Portfolio says it in our units: a Contracts column and the average price in cents
    const held = at(/^(contracts|shares|qty|quantity)\b/);
    const avg = at(/^(avg|average)\b/);
    const nm = held ? /(\d{1,6}(?:,\d{3})*(?:\.\d+)?)/.exec(held) : null;
    const n = nm ? Number(nm[1].replace(/,/g, "")) : 0;
    const c = avg ? /(\d{1,2}(?:\.\d+)?)\s?(?:¢|&cent;|c(?![a-z0-9]))/i.exec(avg) : null;
    const stake = money(at(/^(cost|stake|wager|risk|bet)\b/));
    if (n > 0 && c && Number(c[1]) > 0 && Number(c[1]) < 100) return sizeOfContracts(n, Number(c[1]), stake ? Math.round(stake * 100) : null);
    if (!stake) return null;
    const payout = money(at(/^(payout|pays|return|total return)\b/));
    if (payout && payout > stake) return sizeOf(stake, payout);
    const gain = money(at(/^(to win|to gain|profit|win|gain)\b/));
    if (gain) return sizeOf(stake, stake + gain);
    const price = at(/^(price|odds|avg|average|avg\.? price)\b/);
    const odds = AMERICAN.exec(price);
    const pct = PERCENT.exec(price);
    const cents = CENTS.exec(" " + price);
    const k = odds ? payoutMultiple(Number(odds[1])) : pct && Number(pct[1]) > 0 && Number(pct[1]) < 100 ? 100 / Number(pct[1]) : cents && Number(cents[1]) > 0 ? 100 / Number(cents[1]) : null;
    return k ? sizeOf(stake, stake * k) : null;
  };
  /** Winner (moneyline) or something else. A spread line is a signed one or two digit figure; American odds are three or more. */
  const kindIn = (raw) => {
    const text = spaced(raw);
    const bare = noMoney(text);
    // "Total" the market, not "Total cost" or "Total return" on a slip
    if (/\b(spread|handicap|total(?!\s*(?:cost|return|payout|stake|wager|amount|risk|to win))|over|under|o\/u)\b/i.test(text) || /(^|\s)[+-]\d{1,2}(\.5)?(?=\s|$)/.test(bare)) return /\b(winner|moneyline|money line|ml)\b/i.test(text) ? "winner" : "other";
    return "winner";
  };
  /** Matched, or still an order. A row that says only Unmatched (no matched part, not partially matched) is an order. */
  /** A play the holder has already sold or cashed out is closed at the venue: settled to us. "Sell" (the button) is not it. */
  const SOLD_RE = /\b(sold|cashed out|cash(?:ed)? out)\b/i;
  const matchIn = (raw) => {
    const text = spaced(raw);
    const bare = noMoney(text);
    if (!/\b(unmatched|unfilled|open order|resting|pending|pending match|awaiting match|not matched|working)\b/i.test(bare)) return "matched";
    if (/\b(partially\s+(?:matched|filled)|fully\s+(?:matched|filled)|filled)\b/i.test(bare)) return "matched";
    const m = /(?:^|[^a-z])matched\s*:?\s*\$\s?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
    if (m) return Number(m[1].replace(/,/g, "")) > 0 ? "matched" : "unmatched";
    return /(^|[^a-z])matched\b/i.test(bare) ? "matched" : "unmatched";
  };
  /** The venue's play-money mode (points, not dollars) is never priced. */
  const pointsRow = (raw) => {
    const text = spaced(raw);
    return /\b(prophet|novig)\s*points\b/i.test(text) || (/\b(pts|points)\b/i.test(text) && !/\$\s?\d/.test(text));
  };
  /**
   * Kalshi holds a club's game as Yes or No on that club. A No on the Chiefs is a Yes on the
   * Seahawks: the other market of the same game, which is what the service protects. The row's
   * side word decides; a game with no sibling market listed cannot be flipped.
   */
  const siblingOf = (ticker) => {
    const stem = String(ticker).slice(0, String(ticker).lastIndexOf("-") + 1);
    const others = Object.keys(S.byTicker).filter((t) => t !== ticker && t.startsWith(stem));
    return others.length === 1 ? others[0] : null;
  };
  const sideWord = (raw) => {
    const bare = noMoney(spaced(raw));
    const yes = /(^|[^a-z])yes(?![a-z])/i.test(bare);
    const no = /(^|[^a-z])no(?![a-z])/i.test(bare);
    return no && !yes ? "no" : yes ? "yes" : null;
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
  // ProphetX: Resting / Filled / Settled. Kalshi: Positions / Orders / History. Novig: Active / Settled.
  const TAB_WORDS = /^(resting|open orders?|orders?|unmatched|pending|filled|matched|positions?|open|active|settled|closed|history|past)$/i;
  const tabGroup = (w) => (/^(resting|open orders?|orders?|unmatched|pending)$/i.test(w) ? "resting" : /^(settled|closed|history|past)$/i.test(w) ? "settled" : "filled");
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
  const STAKE_LABELS = /(wager|stake|risk|cost|bet|amount|payout|to\s*win|to\s*gain|to\s*pay|pays)\s*:?\s*\$\s?\d/gi;
  const rowFrom = (node) => {
    let e = node.parentElement;
    let found = null;
    for (let i = 0; e && e !== document.body && i < 9; i++, e = e.parentElement) {
      // a block with a field in it is a form, not a position; our own fields (the shape slider,
      // the typed size) sit inside a deck card and must not turn the card into one
      if (e.querySelector("input:not(.ael-ui *), textarea:not(.ael-ui *)")) break;
      const text = spaced(norm(pageText(e)));
      if (text.length > 600) break;
      const r = e.getBoundingClientRect();
      // wider than the window is the page itself, unless it is a table that scrolls inside its pane;
      // taller than a row is a list, unless it is one card of a deck (a Novig order card runs to
      // its buttons, share line and id), which is one position however tall it stands
      const h = pageHeight(e, r);
      if (h > 320 && !(h <= 640 && e.parentElement && e.parentElement !== document.body && isDeck(e.parentElement))) break;
      if (r.width > window.innerWidth && !e.closest("table")) break;
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
      const moneyWords = /\b(wager|stake|amount|payout|to win|to gain|to pay|pays|returns|cost|avg|average|contracts|shares|risk|matched|odds)\b/i.test(text);
      if ((amounts.length >= 2 || (amounts.length >= 1 && moneyWords)) && r.width >= 200 && r.height >= 24) {
        found = e;
        if (labels >= 1) break;
      }
    }
    return found;
  };

  /** The service's confirmed position for one of our markets, when it has one. */
  const svcFor = (ticker) => S.svc.positions.find((p) => p.ticker === ticker) || null;
  /**
   * The position the service confirms on a market, or the last one it confirmed there: one read
   * at the venue that fails to describe a market (a lookup timed out, a rate limit) must not make
   * the page's own figures take over for twenty seconds and hand back after. The card still on the
   * Active tab is the venue's word that the position stands; a sale moves it off that tab.
   */
  const svcHeld = (ticker) => svcFor(ticker) || (S.svc.configured && S.svcSize.get(ticker)) || null;
  /**
   * A figure read from the page's words that cannot be a position on this market: a price under a
   * cent (no venue sells one), or a payout out of all proportion to the multiplier the row itself
   * prints (a card at 2.00x does not hold a play paying 168 times its stake). Such a reading is
   * noise in the text (an id, a balance, a figure from another block), and no size is better than it.
   */
  const plausible = (size, text) => {
    if (!size || !size.stakeCents || !size.payoutCents) return size;
    const ratio = size.payoutCents / size.stakeCents;
    if (ratio > 100) return null;
    const mult = MULTIPLIER.exec(spaced(text));
    const m = mult ? Number(mult[1]) : 0;
    if (m > 1 && (ratio > 10 * m || ratio * 10 < m)) return null;
    return size;
  };

  /**
   * The title a venue prints above a position rather than on it. Kalshi's Portfolio groups a
   * game's positions under one row ("DET Pistons vs NY Knicks") and each position row names its
   * club alone ("Yes · NY Knicks"). The nearest earlier sibling that carries no money and names a
   * club the row names is the row's title; other positions in between are stepped over, a title
   * naming only other clubs ends the search. Its text is read with the row's.
   */
  const titleOf = (row, text) => {
    const named = clubsNamed(text);
    if (!named.size) return "";
    for (let e = row.previousElementSibling, i = 0; e && i < 8; e = e.previousElementSibling, i++) {
      if (OURS(e)) continue;
      const t = spaced(norm(pageText(e)));
      if (t.length > 300) break;
      if (amountsIn(t).length) continue;
      const clubs = clubsNamed(t);
      if (!clubs.size) continue;
      return [...clubs.keys()].some((k) => named.has(k)) ? t : "";
    }
    return "";
  };

  const findRows = (nodes) => {
    const seen = new Map(); // row element -> { tickers Map, nodes }
    for (const node of nodes) {
      const sides = sidesIn(node.nodeValue);
      // a name this node alone cannot settle (one club, two listed weeks) still marks its row: the
      // row's full text carries the game day, and the pass below reads the row whole
      if (!sides.size && !sides.ambiguous) continue;
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
      const own = spaced(norm(pageText(row)));
      if (pointsRow(own)) continue;
      // the row's own text, and the title above it when it names the row's club: Kalshi's position
      // row says "Yes · NY Knicks", the row over it which game
      const title = titleOf(row, own);
      const text = title ? title + " " + own : own;
      const count = sidesIn(text);
      if (!count.size) continue;
      // a block that names three clubs or more, or prices both Yes and No, is a board (a futures
      // list, a game card with both sides to buy), not one position
      if (count.size > 2) continue;
      if (/(^|[^a-z])yes(?![a-z])/i.test(own) && /(^|[^a-z])no(?![a-z])/i.test(own)) continue;
      // the pick is a club with no listed game: the row is not protected, and it is never read as a
      // pick on the opponent's next game (an Oct 19 Texans row beside the Nov 1 Jaguars listing)
      if (unlistedPick(text)) continue;
      // the pick: the side the venue itself says the holder has (the service reads their account),
      // else a "Team · Winner" style line, else the side named more than once (matchup plus
      // selection), else the only side. The venue's word comes first: a card that prints both
      // clubs and no pick line (Novig's Active card, "CLE … ATL") is read by what they hold, never
      // by which club's letters happen to appear more often.
      let ticker = null;
      if (S.svc.configured) {
        // the one side they hold on the game this card names, whether or not the card's letters
        // for that club were readable (a jersey's text run into the label reads as "CLECLE")
        const stems = new Set([...count.keys()].map(stemOf));
        // the positions this read confirmed and the ones an earlier read did: one read that failed
        // to describe a market at the venue does not turn the card back over to its letters
        const known = [...S.svc.positions, ...S.svcSize.values()];
        const held = [...new Set(known.filter((p) => p.ticker && S.byTicker[p.ticker] && stems.has(stemOf(p.ticker))).map((p) => p.ticker))];
        if (held.length === 1) ticker = held[0];
      }
      const pick = ticker ? null : /([A-Z]{2,3}\s+[A-Za-z0-9 .]+?)(?:\s+[+-]?\d+(?:\.\d)?)?\s*(?:[·•|]|to win)\s*(?:Winner|Moneyline|Money Line|ML|Spread|Total|Over|Under)\b/i.exec(text);
      if (pick) {
        const s = sidesIn(pick[1]);
        if (s.size === 1) ticker = [...s.keys()][0];
        // the pick line names a club the service does not list: not its opponent
        else if (clubsNamed(pick[1]).size) continue;
      }
      if (!ticker) {
        // a card head of code, bullet, multiplier and market ("CLE • 2.02x Winner", Novig) names the
        // pick outright: the row's side with that code, however often the opponent is printed below
        const head = /(^|[^A-Za-z0-9])([A-Z]{2,3})\s*[·•]?\s*\d+(?:\.\d+)?\s?x\s*(?:Winner|Moneyline|Money Line|ML|Spread|Total)\b/.exec(text);
        if (head) {
          const codes = [head[2], ...(CODE_ALIAS[head[2]] || [])];
          const byCode = [...count.keys()].filter((t) => codes.includes(codeOf(t)));
          if (byCode.length === 1) ticker = byCode[0];
          // the head names a club none of the row's sides resolve to: never read as the opponent
          else if (!byCode.length && S.codes.has(head[2])) continue;
        }
      }
      if (!ticker) {
        const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]);
        // one side named more often than any other; a side named once alone is the pick only when no
        // code in the row was left unresolved and no unlisted club is named beside it (else it may be
        // the opponent of the real pick)
        const alone = sorted.length === 1 && (!count.ambiguous || sorted[0][1] >= 2) && (sorted[0][1] >= 2 || !unlistedNamed(text).size);
        if (alone || (sorted.length > 1 && sorted[0][1] > sorted[1][1])) ticker = sorted[0][0];
      }
      if (!ticker) continue;
      // the venue says the holder's position on this game is the other club: the card was misread;
      // no offer on the wrong side (the service refuses such a lock too)
      if (S.svc.configured && !svcHeld(ticker)) {
        const other = siblingOf(ticker);
        if (other && svcHeld(other)) continue;
      }
      // the row names a club that is neither the pick nor its opponent in the listed game: it is a
      // pick on another game (the Pistons game, when the service lists the Knicks' next one only)
      const opp = opponentOf(ticker);
      const mine = new Set([shortOf(ticker), opp].filter(Boolean).map((n) => n.toLowerCase()));
      if (opp && [...clubsNamed(text).keys()].some((k) => !mine.has(k))) continue;
      // Kalshi: a No on the named club is a Yes on the other club of the same game
      let flipped = false;
      if (VENUE_ID === "kalshi" && sideWord(own) === "no") {
        const other = siblingOf(ticker);
        if (!other) continue;
        ticker = other;
        flipped = true;
      }
      // a spread or total row is never sized from the winner position the service holds on the same club;
      // an unmatched play is an order, so the service's confirmed position (if any) is a different play
      const kind = kindIn(own);
      // the page's tab decides what its rows are when the rows themselves do not say
      let match = matchIn(own);
      if (S.tab === "resting" && match === "matched") match = "unmatched";
      if (S.tab === "settled" || SOLD_RE.test(noMoney(spaced(own)))) match = "settled";
      // the venue's own figure for a position it confirms: a card that reads as matched, or one whose
      // words say nothing either way (Novig's Active card carries no badge) while the venue holds it
      const held = kind === "winner" && match !== "settled" ? svcHeld(ticker) : null;
      const svc = held && (match === "matched" || !/(^|[^a-z])unmatched\b/i.test(noMoney(spaced(own)))) ? held : null;
      const read = match === "matched" ? plausible(tableSize(row) || sizeIn(own), own) : null;
      out.push({ row, ticker, kind, match, flipped, size: svc ? { contracts: svc.contracts, entryCents: svc.entryCents, stakeCents: svc.costCents, payoutCents: svc.payoutCents } : read, from: svc ? "service" : read ? "page" : "none" });
    }
    return out;
  };

  // ── our line and panel under a row ──────────────────────────────────────────
  // keyed by market; a spread or total row on the same club keeps its own panel state, so opening
  // the one never opens the other
  const stateOf = (B) => {
    const key = B.slip ? B.ticker + "#slip" : B.kind && B.kind !== "winner" ? B.ticker + "#" + B.kind : B.ticker;
    let st = S.st.get(key);
    if (!st) {
      st = { quote: null, quoteAt: 0, quoteKey: "", tier: null, open: false, enter: false, how: false, details: false, rules: false, busy: false, done: null, pending: false, rcpt: false, rcptHedge: null, rcptRule: null, rcptCash: null, rcptBusy: false, rcptLoaded: false, rcptErr: "" };
      S.st.set(key, st);
    }
    return st;
  };

  /**
   * A parent that lays its children out side by side AND down: a wrapping flex row or a grid with
   * more than one column. Novig's Portfolio is such a deck of cards. A block placed after one card
   * there would land beside it, or after the whole deck; it goes inside the card instead.
   */
  const isDeck = (parent) => {
    const cs = getComputedStyle(parent);
    if (cs.display.includes("grid")) return (cs.gridTemplateColumns || "").trim().split(/\s+/).filter(Boolean).length > 1;
    // a wrapping row is a deck with one card in it as with five: the one card is read and placed the same way
    return cs.display.includes("flex") && !cs.flexDirection.startsWith("column") && cs.flexWrap === "wrap";
  };
  /**
   * Where our block goes: after the row, climbing out of flex/grid rows so it lands under the row,
   * not beside it; or, when the row is a card in a deck, inside the card as its last child
   * (`{ inside: true }`), under the card's own rows.
   */
  const insertionPoint = (row) => {
    if (row.parentElement && row.parentElement !== document.body && isDeck(row.parentElement)) {
      const cs = getComputedStyle(row);
      if (cs.display === "block" || (cs.display.includes("flex") && cs.flexDirection.startsWith("column"))) return { el: row, inside: true };
    }
    let target = row;
    for (let i = 0; i < 3 && target.parentElement && target.parentElement !== document.body; i++) {
      const cs = getComputedStyle(target.parentElement);
      const horizontal = (cs.display.includes("flex") && !cs.flexDirection.startsWith("column")) || cs.display.includes("grid") || cs.display.includes("inline");
      if (!horizontal) break;
      target = target.parentElement;
    }
    return { el: target, inside: false };
  };
  const placeHost = (host, at) => {
    if (at.inside) at.el.appendChild(host);
    else at.el.insertAdjacentElement("afterend", host);
  };

  const mountHost = (B) => {
    const at = insertionPoint(B.row);
    const after = at.el;
    let host;
    if (after.tagName === "TR") {
      host = document.createElement("tr");
      host.className = "ael-ui ael-host " + SKIN;
      const td = document.createElement("td");
      td.colSpan = 99;
      td.innerHTML = '<div class="ael-ui ael-row"></div>';
      host.appendChild(td);
      B.box = td.firstElementChild;
    } else {
      host = document.createElement("div");
      host.className = "ael-ui ael-host " + SKIN;
      host.innerHTML = '<div class="ael-ui ael-row"></div>';
      B.box = host.firstElementChild;
    }
    host.addEventListener("click", (e) => e.stopPropagation());
    if (at.inside) host.classList.add("ael-inside");
    placeHost(host, at);
    B.host = host;
    B.after = after;
    B.inside = at.inside;
    fitHost(B);
  };

  /** An existing block back under its row, as it is; built afresh only when the row's shape changed. */
  const remountHost = (B) => {
    const at = insertionPoint(B.row);
    const after = at.el;
    if (!B.host || (after.tagName === "TR") !== (B.host.tagName === "TR") || Boolean(B.inside) !== at.inside) {
      B.host && B.host.remove();
      mountHost(B);
      return;
    }
    if (B.after !== after || !B.host.isConnected) {
      placeHost(B.host, at);
      B.after = after;
    }
    fitHost(B);
  };

  /** The ancestor a table scrolls sideways in, when the table is wider than it; else null. */
  const scrollPaneOf = (el) => {
    for (let e = el.parentElement, i = 0; e && e !== document.body && i < 12; e = e.parentElement, i++) {
      if (e.scrollWidth <= e.clientWidth + 2) continue;
      const ox = getComputedStyle(e).overflowX;
      if (ox === "auto" || ox === "scroll") return e;
    }
    return null;
  };

  /** Our block spans the row's own width and left edge. */
  const fitHost = (B) => {
    if (B.card || !B.host || !B.row.isConnected) return;
    // inside a card our block is one of its rows: the card's width, no offset
    if (B.inside) {
      if (B.box.style.width) B.box.style.marginLeft = B.box.style.width = "";
      return;
    }
    // in a table our cell already spans every column; sizing it to the row would widen the table,
    // which widens the row, which would size it again
    if (B.host.tagName === "TR") {
      // a table wider than the pane it scrolls in (Kalshi's Portfolio on a narrow window): our
      // block keeps to the pane's width and sticks to its left edge, so it stays in view
      const pane = scrollPaneOf(B.host);
      if (pane) {
        B.box.style.position = "sticky";
        B.box.style.left = "0px";
        B.box.style.width = Math.max(240, pane.clientWidth) + "px";
      } else if (B.box.style.position) {
        B.box.style.position = B.box.style.left = B.box.style.width = "";
      }
      return;
    }
    const rr = B.row.getBoundingClientRect();
    const hr = B.box.getBoundingClientRect();
    if (!rr.width) return;
    const ml = parseFloat(B.box.style.marginLeft || "0") + (rr.left - hr.left);
    B.box.style.marginLeft = Math.round(ml) + "px";
    B.box.style.width = Math.round(rr.width) + "px";
  };

  /** The quote at this row's size, refreshed while the page is open; the lock reprices at the tap. */
  const quoteRow = (B) => {
    const st = stateOf(B);
    if (!B.size || (st.done && !removedHere(B.ticker, st.done)) || (S.record.has(B.ticker) && !removedHere(B.ticker))) return;
    const key = B.ticker + ":" + B.size.contracts + ":" + (B.size.entryCents || "");
    if (st.pending || st.busy) return;
    if (st.quoteKey === key && Date.now() - st.quoteAt < REQUOTE_MS) return;
    st.pending = true;
    // the venue this page is: the service routes the hedge against its settlement rules (which book
    // takes the other side tonight, and what the tails cost) and words the terms in its rules
    const path = "/api/shadow/quote?ticker=" + encodeURIComponent(B.ticker) + "&contracts=" + B.size.contracts + (B.size.entryCents ? "&entry=" + B.size.entryCents : "") + "&venue=" + encodeURIComponent(VENUE_ID);
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
          // the service's own default heads the quote (the most upside unless it is configured otherwise)
          if (!st.tier || !(q.tiers && q.tiers[st.tier])) st.tier = q.tier;
        }
      }
      if (B.slip) paintSlip(B);
      else paintRow(B);
    });
  };

  /** Plain words for a refusal, and what to do about it. */
  const refusalWords = (code, message) => {
    switch (code) {
      case "credit_too_small":
      case "credit_nonpositive":
        return { why: "The credit at this size is under our minimum.", next: "Protection on this pick starts at a larger position. Check back closer to the start; the price moves." };
      case "too_expensive":
      case "protection_too_rich":
        return { why: "Protecting this pick costs more than we will pay at the current price.", next: "Check back later; the book moves toward the start." };
      case "not_offered":
      case "no_matched_market":
      case "league_not_covered":
      case "no_protectable_market":
        return { why: "No hedge book for this game yet.", next: "Protection reaches more games as venues are added." };
      case "market_not_covered":
      case "spread":
        return { why: "Protection covers the Moneyline market.", next: "A Moneyline pick on this game can be locked in." };
      case "unmatched":
        return VENUE_ID === "kalshi"
          ? { why: "This order has not filled yet.", next: "It is a resting order until the book fills it. Protection prices on the contracts you hold; check back once it fills." }
          : { why: "This " + V.play + " has not been matched yet.", next: "It is an order until another account takes the other side. Protection prices on the matched stake; check back once it fills." };
      case "settled":
        return { why: "This " + V.play + " settled without protection.", next: "Protection is locked before the game starts. A locked " + V.play + " shows what it paid here once it settles." };
      case "too_early":
      case "far_out_no_book":
        return { why: "It is too early to protect this pick.", next: "Protection opens closer to the start of this one." };
      case "price_unsettled":
      case "mark_disagreement":
        return { why: "The price on this pick has not settled yet.", next: "Check back closer to the start; protection prices once the market agrees on the odds." };
      case "market_too_close_to_start":
      case "market_not_active":
        return { why: "This game starts too soon to protect.", next: "Protection is available until shortly before the start." };
      case "already_on_record":
        return { why: "This market is already locked.", next: "One lock per market." };
      case "on_record_elsewhere":
        return { why: message || "This game is already protected.", next: "One lock per game. The protection sits with the pick held there." };
      case "wrong_side":
        return { why: message || "Your pick on this game is the other club.", next: "Nothing was locked. Protect the pick from its own card." };
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

  /**
   * Where the money stands on a lock, from the record's cash legs (what each leg owes, what was
   * paid): what is still owed to the holder, what the holder still owes back, or paid in full.
   * Null when the service's record predates cash legs; the line then says only what settled.
   */
  const LEG_WORDS = { credit: "Credit", floor: "Floor", handback: "Above the cap", close: "Protection removed" };
  /**
   * Why the protection settles the way it does, in the holder's terms: the pick moved up, so the
   * upside they sold is worth more now; moved down, so the floor they hold is worth more now.
   */
  const closeWhy = (net) => (net < 0 ? "your pick moved up, so the upside you sold is worth more now" : net > 0 ? "your pick moved down, so the floor you hold is worth more now" : "even at today's price");
  const cashState = (rec) => {
    const legs = Array.isArray(rec.cashDue) ? rec.cashDue : null;
    if (!legs || !legs.length) return null;
    const toYou = legs.filter((l) => l.to === "holder").reduce((s, l) => s + (l.outstandingCents || 0), 0);
    const back = legs.filter((l) => l.to === "writer").reduce((s, l) => s + (l.outstandingCents || 0), 0);
    if (toYou > 0) return { label: esc(usd(toYou)) + " owed to you", sub: "on its way", open: true };
    // what is owed back: the slice above the cap on a win, or the protection's settlement on a leave
    if (back > 0) return { label: esc(usd(back)) + " due back", sub: legs.some((l) => l.leg === "close" && l.to === "writer" && l.outstandingCents > 0) ? "the protection's settlement" : "the slice above the cap", open: true };
    return { label: "paid in full", sub: "", open: false };
  };
  /** What a leave moved between the two parties beyond the credit: the record's own totals, or the tap's answer. */
  const closeNetOf = (rec) => (rec.closeNetCents != null ? rec.closeNetCents : (rec.protectedCents || 0) - (rec.nakedCents || 0) - (rec.creditCents || 0));
  const signed = (c) => (c < 0 ? "\u2212" : "+") + esc(usd(Math.abs(c)));
  const legLine = (l) => {
    const who = l.to === "holder" ? "to you" : "back to the writer";
    const amount = (l.to === "holder" && l.leg === "credit" ? "+" : "") + esc(usd(l.dueCents));
    if (l.outstandingCents === 0 && l.paidCents > 0) return amount + ' <span class="ael-dim">&middot; paid ' + (l.paidAt ? esc(fmtAt(l.paidAt)) : "") + "</span>";
    if (l.paidCents > 0) return amount + ' <span class="ael-dim">&middot; ' + esc(usd(l.paidCents)) + " paid, " + esc(usd(l.outstandingCents)) + " owed " + who + "</span>";
    return amount + ' <span class="ael-dim">&middot; owed ' + who + "</span>";
  };

  const CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  /**
   * The line is the badge: the filled shield and one word or two in a pill ("Lock in", "Protected",
   * "Unavailable"), then one sentence in the venue's row type, then the chevron. The pill is solid
   * once the position is protected; muted while we wait or when protection is off. A muted pill
   * carries no shield: the dim outline read as an empty slot on a dark venue and left the word
   * sitting off-centre, so the word stands alone, centred.
   */
  const lineGo = (label, fact, cls) => {
    const muted = cls === "ael-line-off" || cls === "ael-line-wait";
    return '<button type="button" class="ael-line ' + (cls || "") + '"><span class="ael-tag">' + (muted ? "" : '<span class="ael-ic">' + SHIELD_FILL + "</span>") + "<b>" + label + "</b></span>" + (fact ? '<span class="ael-fact">' + fact + "</span>" : "") + '<span class="ael-chev">' + CHEVRON + "</span></button>";
  };

  /** The line under the row, from the row's state. */
  const paintRow = (B) => {
    if (!B.box) return;
    const st = stateOf(B);
    // a lock on this market covers the Winner position; a spread or total row on the same club is not it;
    // one whose protection was removed on a game offered again is no longer the row's state
    const held = B.kind === "winner" ? lockHere(B.ticker) || st.done : null;
    const rec = held && removedHere(B.ticker, held) ? null : held;
    // a settled order here was never protected, whatever the record holds for the game elsewhere
    const away = !rec && B.kind === "winner" && B.match !== "settled" ? lockAway(B.ticker) : null;
    let line;
    if (away) {
      line = lineGo("Unavailable", "Protected on " + esc(venueNameOf(away.holderVenue)) + " already.", "ael-line-off");
    } else if (rec) {
      const rs = outcomes(B, rec.contracts, rec.floorCents, rec.capCents, rec.creditCents);
      if (rec.status === "settled" && rec.result) {
        // the protected outcome is the record's; whether the cash has moved is said beside it,
        // never as "paid" on its own, since the holder can see at the venue whether it has
        const got = usd(rec.protectedCents != null ? rec.protectedCents : rec.result === "yes" ? rs.capTotal : rs.floorTotal);
        const cash = cashState(rec);
        line = cash
          ? lineGo("Settled", cash.open ? "Protected outcome <b>" + esc(got) + "</b> &middot; " + cash.label + (cash.sub ? " &middot; " + cash.sub : "") : "Paid <b>" + esc(got) + "</b> &middot; every leg paid.", "ael-line-on")
          : lineGo("Settled", "Protected outcome <b>" + esc(got) + "</b>.", "ael-line-on");
      } else if (rec.status === "void") line = lineGo("Voided", "No official result; nothing owed.", "ael-line-on");
      else if (rec.status === "closed") {
        // protection removed: what the protection alone settled for, and whether that cash has moved;
        // the pick itself is still the venue's live position, not ours to describe
        const net = closeNetOf(rec);
        const cash = cashState(rec);
        const moved = cash ? (cash.open ? (net >= 0 ? " &middot; on its way" : "") : " &middot; paid") : "";
        line = lineGo("Protection removed", "<b>" + signed(net) + "</b> " + (net < 0 ? "due back" : "to you") + moved + "." + (rec.rehearsal ? " &middot; rehearsal" : ""), "ael-line-on");
      } else {
        // the venue the other side went to, on the line itself, so the pick is visible without opening the panel
        const hv = hedgeVenueOf(rec.routing);
        line = lineGo("Protected", "<b>" + esc(usd(rs.floorTotal)) + "</b> or <b>" + esc(usd(rs.capTotal)) + "</b>" + (hv ? " &middot; on " + esc(hv) : ", whichever way it goes") + "." + (rec.rehearsal ? " &middot; rehearsal" : ""), "ael-line-on");
      }
    } else if (B.kind === "other") {
      line = lineGo("Unavailable", "Protection covers " + (VENUE_ID === "novig" ? "Winner" : "Moneyline") + " picks.", "ael-line-off");
    } else if (B.match === "unmatched") {
      line = lineGo("Unavailable", VENUE_ID === "kalshi" ? "Protection waits until the order fills." : "Protection waits until the " + esc(V.play) + " is matched.", "ael-line-off");
    } else if (!B.size) {
      line = lineGo("Lock in", "Size not read from the page.", "");
    } else if (!st.quote) {
      line = lineGo("Lock in", "Checking protection&hellip;", "ael-line-wait");
    } else if (!st.quote.ok) {
      line = lineGo("Unavailable", esc(refusalWords(st.quote.code, st.quote.message).why), "ael-line-off");
    } else {
      const p = st.quote.p;
      const q = p.quote;
      const t = (q.tiers && q.tiers[st.tier]) || q;
      const n = q.contracts || p.contracts;
      const rs = outcomes(B, n, t.floorCents, t.capCents, t.creditCents);
      // one number on the line: the floor. The rest is one tap away, in the panel.
      line = offerLine(rs);
    }
    // repaint only what changed: the venue re-renders often and every scan lands here, so
    // rewriting the same HTML would make the block blink and drop anything typed in it
    if (B.lineHtml !== line || !B.box.querySelector(".ael-line") || !B.box.querySelector(".ael-panel")) {
      B.box.innerHTML = '<div class="ael-box">' + line + '<div class="ael-panel"></div></div>';
      B.lineHtml = line;
      B.panelHtml = null;
      B.box.querySelector(".ael-line").onclick = () => {
        st.open = !st.open;
        if (st.open) st.enter = true;
        else {
          st.how = false;
          st.details = false;
          st.rules = false;
          // the "Locked in" moment is shown once; the next open is the position's details
          if (st.done) st.done.justNow = false;
          const r = S.record.get(B.ticker);
          if (r) r.justNow = r.justLeft = false;
        }
        paintRow(B);
      };
    }
    const panel = B.box.querySelector(".ael-panel");
    panel.classList.toggle("ael-on", Boolean(st.open));
    // the panel slides in once, at the holder's tap or the lock; a repaint or a venue re-render that
    // moves our block never replays it, or the block would blink every time the page redrew
    if (!st.open) panel.classList.remove("ael-enter");
    else if (st.enter) {
      st.enter = false;
      panel.classList.add("ael-enter");
      panel.addEventListener("animationend", () => panel.classList.remove("ael-enter"), { once: true });
    }
    B.box.querySelector(".ael-line").classList.toggle("ael-open", Boolean(st.open));
    // the lock lands once: the line fills solid for a beat, then settles to Protected
    if (rec && rec.justNow && !st.flashed) {
      st.flashed = true;
      const ln = B.box.querySelector(".ael-line");
      ln.classList.add("ael-flash");
      ln.addEventListener("animationend", () => ln.classList.remove("ael-flash"), { once: true });
    }
    if (st.open) paintPanel(B);
    else B.panelHtml = null;
    fitHost(B);
  };

  /** Set the panel's HTML and bind its handlers, unless it already shows exactly this. */
  const setPanel = (B, panel, html, bind) => {
    if (B.panelHtml === html && panel.firstChild) return;
    panel.innerHTML = html;
    B.panelHtml = html;
    if (bind) bind();
  };

  const DISCLOSE = '<div class="ael-disclose">Protection by Atticus, a third party; not a product of this venue.</div>';
  const operator = () => S.settings.showHedge === "yes";
  /**
   * The simple layout (the default): two outcomes, the cash, one pill, and everything else behind
   * Adjust (the shape, as a slider) and Details (where the other side went, the clock, how it
   * works, the rules). The full layout (Options) keeps every figure in view for an operator demo.
   */
  const simple = () => S.settings.layout !== "full";
  /** The collapsed offer: the floor, and nothing else. */
  const offerLine = (rs) => lineGo("Lock in", "Lose, and still get <b>" + esc(usd(rs.floorTotal)) + "</b>.", "");

  /** The notes a holder needs once, in the fine print: a Kalshi No read as the other club's Yes; where the size came from (operator). */
  const notes = (B) => {
    const out = [];
    // a Kalshi No on the other club is this club's Yes; say so once, in the holder's own words
    if (B.flipped) out.push("your No on the " + esc(shortOf(siblingOf(B.ticker) || "")));
    if (operator() && B.from === "page") out.push("size read from the page");
    return out;
  };

  /**
   * The slip: three rows with dividers, the way the venue's own ticket lays out a deal. Win, lose
   * (the floor, the one coloured number), paid to you. Before the tap a third column says what
   * each was unprotected; after it the two columns stand alone.
   */
  const ledgerRow = (label, value, third, cls) => '<div class="ael-lr' + (cls ? " " + cls : "") + '"><span class="ael-l">' + label + "</span><b>" + value + "</b>" + (third != null ? "<s>" + third + "</s>" : "") + "</div>";
  const ledger = (nick, rs, creditCents, was) =>
    '<div class="ael-ledger' + (was ? "" : " ael-two") + '">' +
    ledgerRow(esc(nick) + " win", esc(usd(rs.capTotal)), was ? "was " + esc(was) : null) +
    ledgerRow(esc(nick) + " lose", esc(usd(rs.floorTotal)), was ? "was $0" : null, "ael-hero") +
    ledgerRow(was ? "Paid to you now" : "Paid to you", "+" + esc(usd(creditCents)), was ? "today" : null, "ael-last") +
    "</div>";

  /**
   * The simple slip: the two ways the game can go and the cash, nothing a holder has to decode.
   * Before the tap the third column says what each outcome is without the protection ("of
   * $15.38", "instead of $0"); after it the figures stand alone.
   */
  const simpleLedger = (nick, rs, creditCents, was) =>
    '<div class="ael-ledger' + (was ? "" : " ael-two") + '">' +
    ledgerRow(esc(nick) + " win", esc(usd(rs.capTotal)), was ? "of " + esc(was) : null) +
    ledgerRow(esc(nick) + " lose", esc(usd(rs.floorTotal)), was ? "instead of $0" : null, "ael-hero") +
    ledgerRow("Cash now", "+" + esc(usd(creditCents)), was ? "" : null, "ael-last") +
    "</div>";

  /** What the slider reads out to a screen reader at each stop. */
  const tierValueText = (k, tr, tt) => TIER_WORDS[k] + ": win " + usd(tr.capTotal) + ", lose " + usd(tr.floorTotal) + ", " + usd(tt.creditCents) + " now";
  /**
   * The shape as a slider: more upside on the left, a higher floor on the right, the stop's name
   * between the ends. Only the shapes the book offers for this pick are stops (two or three); the
   * figures above move as it moves, so the trade-off is seen rather than read.
   */
  const sliderHtml = (B, n, offered, keys, tier) => {
    const i = Math.max(0, keys.indexOf(tier));
    const tt = offered[keys[i]];
    const tr = outcomes(B, n, tt.floorCents, tt.capCents, tt.creditCents);
    return (
      '<div class="ael-adjust"><div class="ael-adj-h"><span>More upside</span><b>' + esc(TIER_WORDS[keys[i]]) + "</b><span>Higher floor</span></div>" +
      '<input type="range" class="ael-range" min="0" max="' + (keys.length - 1) + '" step="1" value="' + i + '" aria-label="Shape of the deal" aria-valuetext="' + esc(tierValueText(keys[i], tr, tt)) + '" /></div>'
    );
  };

  /**
   * One toggle everywhere (Details, Rules): the label stays, the chevron turns, aria-expanded says
   * which. The same shape in the offer, under the protected slip and inside the receipt.
   */
  const toggleA = (cls, label, open) => '<a href="#" class="ael-tg ' + cls + '" aria-expanded="' + (open ? "true" : "false") + '">' + label + '<span class="ael-tgc">' + CHEVRON + "</span></a>";

  /** How it works, as three lines a holder can scan: the sale, the two outcomes, what is left to do. */
  const howList = (nick, rs, was, shopped) =>
    '<ul class="ael-howl">' +
    "<li>You sell part of this position at today's price and keep the rest. That is the cash now.</li>" +
    "<li>" + esc(nick) + ' lose: <b class="ael-hl-floor">' + esc(usd(rs.floorTotal)) + "</b> instead of $0. " + esc(nick) + ' win: <b class="ael-hl-cap">' + esc(usd(rs.capTotal)) + "</b> instead of " + esc(was) + ".</li>" +
    "<li>Settles on the same official result as your pick; nothing to manage. The other side is bought the second you tap" + (shopped ? ", at the best price across the venues that quoted it" : "") + ".</li>" +
    "</ul>";

  /**
   * The rules as a grid, one case a row: what the venue does with the position, and (dim) what the
   * protection does with it, read from the routing's rule cells (treatment per branch). The venue's
   * own sentence is the row's tooltip; a routing without cells falls back to the sentences.
   */
  const CASE_WORDS = { tie: "ends in a tie", postponed: "is postponed", abandoned: "is called off, no official result", corrected: "has its result corrected later" };
  const VENUE_DOES = { half: "pays each side $0.50", void: "voids the pick and returns the stake", fair: "settles at the fair price when the news broke", hold: "keeps the market open until it is played", stands: "settles on the result as first announced", resettle: "settles again on the corrected result" };
  const PROTECTION_DOES = { half: "the protection settles on that $0.50", void: "the protection is void too; you keep the credit", fair: "the protection settles on that price", hold: "the protection waits with it", stands: "so does the protection", resettle: "so does the protection" };
  const hoursWords = (h) => (h % 24 === 0 && h > 48 ? h / 24 + " days" : h + " hours");
  const rulesGrid = (rt) => {
    const cells = rt.rules || {};
    const venue = rt.holderVenueName || V.name;
    const rows = rt.tails.map((t) => {
      const c = cells[t.branch] || {};
      const does = VENUE_DOES[c.treatment];
      let when = CASE_WORDS[t.branch] || String(t.branch || "");
      if (t.branch === "postponed" && does && c.treatment !== "hold" && c.windowHours) when += " past " + hoursWords(c.windowHours);
      const right = does ? esc(venue) + " " + does + ' <span class="ael-dim">&middot; ' + PROTECTION_DOES[c.treatment] + "</span>" : esc(String(t.text || ""));
      const tip = ' title="' + esc(String(t.text || "")) + '"';
      return '<div class="ael-rg"><span' + tip + ">" + esc(when) + "</span><b" + tip + ">" + right + "</b></div>";
    });
    return '<div class="ael-rgrid"><div class="ael-rgh">If the game&hellip;</div>' + rows.join("") + "</div>";
  };

  /** The rules row: the toggle, the cases it covers while folded, the grid when open. */
  const rulesHtml = (rt, open) => {
    if (!rt || !Array.isArray(rt.tails) || !rt.tails.length) return "";
    return '<div class="ael-rulesrow">' + toggleA("ael-rules-a", "Rules", open) + (open ? "" : '<span class="ael-dim">' + esc(tailSummary(rt.tails)) + "</span>") + "</div>" + (open ? rulesGrid(rt) : "");
  };

  /** The offer in the simple layout; a string, so a slide can refresh the figures in place and keep the panel's record of itself true. */
  const simpleOfferHtml = (B, st, p, q, offered, keys, n, removedLine) => {
    const t = offered[st.tier] || q;
    const rs = outcomes(B, n, t.floorCents, t.capCents, t.creditCents);
    const was = usd(centsOf(100, n));
    const fine = ["Priced live"];
    if (p.eventTimeIso) fine.push("until " + esc(startWord(stemOf(p.ticker || B.ticker || ""))) + " " + esc(fmtAt(p.eventTimeIso)));
    fine.push(...notes(B));
    const shopped = pricedCount(p.routing) > 1;
    // one toggle beside the pill; the shape (slider), the venues, the clock, how it works and the rules wait behind it
    const details = st.details
      ? '<div class="ael-details">' +
        (keys.length > 1 ? sliderHtml(B, n, offered, keys, st.tier) : "") +
        venuePick(p.routing) +
        '<div class="ael-fine">' + fine.join(" &middot; ") + "</div>" +
        howList(shortOf(B.ticker), rs, was, shopped) +
        rulesHtml(p.routing, st.rules) +
        "</div>"
      : "";
    return (
      simpleLedger(shortOf(B.ticker), rs, t.creditCents, was) +
      '<div class="ael-acts ael-offer-acts"><button type="button" class="ael-go ael-pillgo" id="ael-go-' + esc(B.ticker) + '"><span class="ael-ic">' + SHIELD_FILL + '</span>Lock in</button><span class="ael-links">' + toggleA("ael-det-a", "Details", st.details) + "</span></div>" +
      removedLine +
      details +
      DISCLOSE
    );
  };

  const paintPanel = (B) => {
    const st = stateOf(B);
    const panel = B.box.querySelector(".ael-panel");
    const held = B.kind === "winner" ? lockHere(B.ticker) || st.done : null;
    const removed = held ? removedHere(B.ticker, held) : null;
    const rec = removed ? null : held;
    if (rec) return paintDetails(B, panel, rec);
    const away = B.kind === "winner" && B.match !== "settled" ? lockAway(B.ticker) : null;
    if (away) return paintRefusal(B, panel, "on_record_elsewhere", "Already protected on " + venueNameOf(away.holderVenue) + ".");
    if (B.kind === "other") return paintRefusal(B, panel, "spread", "");
    if (B.match === "unmatched") return paintRefusal(B, panel, "unmatched", "");
    if (B.match === "settled") return paintRefusal(B, panel, "settled", "");
    if (!B.size) return paintRefusal(B, panel, "no_size", "");
    if (!st.quote) {
      setPanel(B, panel, '<div class="ael-skel"></div><div class="ael-skel" style="width:70%"></div>');
      return;
    }
    if (!st.quote.ok) return paintRefusal(B, panel, st.quote.code, st.quote.message);
    const p = st.quote.p;
    const q = p.quote;
    const offered = q.tiers || {};
    const t = offered[st.tier] || q;
    const n = q.contracts || p.contracts;
    const rs = outcomes(B, n, t.floorCents, t.capCents, t.creditCents);
    // what the position pays unprotected: $1 a contract, the venue's own figure to the cent
    const was = usd(centsOf(100, n));
    let seg = "";
    const keys = TIER_ORDER.filter((k) => offered[k]);
    if (keys.length > 1) {
      for (const k of keys) {
        const tt = offered[k];
        const tr = outcomes(B, n, tt.floorCents, tt.capCents, tt.creditCents);
        seg += '<button type="button" class="ael-seg" data-tier="' + k + '" aria-pressed="' + (k === st.tier) + '"><b>' + TIER_WORDS[k] + "</b><span><i>Floor " + esc(usd(tr.floorTotal)) + " &middot;</i> <i>Upside " + esc(usd(tr.capTotal)) + " &middot;</i> <i>+" + esc(usd(tt.creditCents)) + " now</i></span></button>";
      }
    }
    const fine = ["Priced live"];
    if (p.eventTimeIso) fine.push("until " + esc(startWord(stemOf(p.ticker || B.ticker || ""))) + " " + esc(fmtAt(p.eventTimeIso)));
    // the protection removed earlier on this game, one grey line: what it settled for, and whether that moved
    const removedLine = removed ? '<div class="ael-fine">Earlier protection removed' + (removed.closedAt ? " " + esc(fmtAt(removed.closedAt)) : "") + " &middot; " + signed(closeNetOf(removed)) + " " + (closeNetOf(removed) < 0 ? "due back" : "to you") + (cashState(removed) && !cashState(removed).open ? " &middot; paid" : "") + ".</div>" : "";
    if (simple()) {
      const html = simpleOfferHtml(B, st, p, q, offered, keys, n, removedLine);
      setPanel(B, panel, html, () => {
        const toggle = (sel, key) => {
          const a = panel.querySelector(sel);
          if (a)
            a.onclick = (e) => {
              e.preventDefault();
              e.stopPropagation();
              st[key] = !st[key];
              paintRow(B);
            };
        };
        toggle(".ael-det-a", "details");
        toggle(".ael-rules-a", "rules");
        const range = panel.querySelector(".ael-range");
        if (range)
          range.oninput = () => {
            // the figures follow the thumb in place: a repaint here would rebuild the slider under the drag
            st.tier = keys[Number(range.value)] || st.tier;
            const tt = offered[st.tier];
            const tr = outcomes(B, n, tt.floorCents, tt.capCents, tt.creditCents);
            const vals = panel.querySelectorAll(".ael-ledger .ael-lr > b");
            if (vals.length >= 3) {
              vals[0].textContent = usd(tr.capTotal);
              vals[1].textContent = usd(tr.floorTotal);
              vals[2].textContent = "+" + usd(tt.creditCents);
            }
            const word = panel.querySelector(".ael-adj-h b");
            if (word) word.textContent = TIER_WORDS[st.tier];
            // the how-it-works line quotes the same two figures
            const hlFloor = panel.querySelector(".ael-hl-floor");
            if (hlFloor) hlFloor.textContent = usd(tr.floorTotal);
            const hlCap = panel.querySelector(".ael-hl-cap");
            if (hlCap) hlCap.textContent = usd(tr.capTotal);
            range.setAttribute("aria-valuetext", tierValueText(st.tier, tr, tt));
            const factB = B.box.querySelector(".ael-line .ael-fact b");
            if (factB) factB.textContent = usd(tr.floorTotal);
            // the panel and the line now show what a fresh paint would draw; say so, or the next scan redraws them
            B.panelHtml = simpleOfferHtml(B, st, p, q, offered, keys, n, removedLine);
            B.lineHtml = offerLine(tr);
          };
        panel.querySelector(".ael-go").onclick = () => lockIn(B, n, offered[st.tier] || q);
      });
      return;
    }
    // the venue pick is its own strip above the button; the fine print keeps the competition only when the strip has nothing to show
    const picked = venuePick(p.routing);
    fine.push(...notes(B), ...(picked ? [] : routingNotes(p.routing)), '<a href="#" class="ael-how-a">how it works</a>');
    const shopped = pricedCount(p.routing) > 1;
    const html =
      (seg ? '<div class="ael-segs">' + seg + "</div>" : "") +
      ledger(shortOf(B.ticker), rs, t.creditCents, was) +
      picked +
      '<button type="button" class="ael-go" id="ael-go-' + esc(B.ticker) + '"><span class="ael-ic">' + SHIELD_FILL + "</span>Lock in</button>" +
      removedLine +
      '<div class="ael-fine">' + fine.join(" &middot; ") + "</div>" +
      '<div class="ael-how' + (st.how ? " ael-on" : "") + '"><p>You sell part of this position at today\'s price and keep the rest. That is why you are paid now.</p><p>If ' + esc(shortOf(B.ticker)) + " lose you end with " + esc(usd(rs.floorTotal)) + " instead of $0. If they win, " + esc(usd(rs.capTotal)) + " instead of " + esc(was) + ".</p><p>It settles on the same official result as your position; nothing to manage. The other side is bought the second you tap" + (shopped ? ", at the best price across the venues that quoted it, not only here" : "") + ".</p></div>" +
      DISCLOSE;
    setPanel(B, panel, html, () => {
      for (const c of panel.querySelectorAll("[data-tier]"))
        c.onclick = () => {
          st.tier = c.getAttribute("data-tier");
          paintRow(B);
        };
      panel.querySelector(".ael-how-a").onclick = (e) => {
        e.preventDefault();
        st.how = !st.how;
        B.panelHtml = null;
        paintRow(B);
      };
      panel.querySelector(".ael-go").onclick = () => lockIn(B, n, t);
    });
  };

  const paintRefusal = (B, panel, code, message) => {
    const w = refusalWords(code, message);
    const sizeForm =
      code === "no_size"
        ? '<div class="ael-size-form"><input type="number" min="1" max="10000" step="0.01" placeholder="pays $" aria-label="Payout in dollars" /><button type="button" class="ael-go ael-quiet">Price it</button></div>'
        : "";
    const fine = code === "spread" || code === "no_size" || code === "unmatched" ? "" : '<div class="ael-fine">Protection is offered when the market pays for it.</div>';
    const html = '<div class="ael-ph"><b>' + esc(w.why) + "</b>" + (w.next ? "<span>" + esc(w.next) + "</span>" : "") + "</div>" + sizeForm + fine + DISCLOSE;
    setPanel(B, panel, html, () => {
      if (sizeForm) {
        const inp = panel.querySelector("input");
        panel.querySelector(".ael-quiet").onclick = () => {
          const pays = Math.round((Number(inp.value) || 0) * 100) / 100;
          if (pays < 1) return;
          B.size = { contracts: pays, entryCents: null, stakeCents: 0, payoutCents: Math.round(pays * 100) };
          B.from = "entered";
          quoteRow(B);
          paintRow(B);
        };
      }
    });
  };

  const lockIn = async (B, n, t) => {
    const st = stateOf(B);
    if (st.busy) return;
    st.busy = true;
    const go = B.box.querySelector(".ael-go");
    go.disabled = true;
    const t0 = Date.now();
    // the stages in words, a slow sheen, and whole seconds only once it has taken a few: calm to watch
    const STAGES = ["Pricing from the live book…", "Writing the record…", "Buying the other side…"];
    const label = () => {
      const s = (Date.now() - t0) / 1000;
      return STAGES[Math.min(STAGES.length - 1, Math.floor(s / 1.5))] + (s >= 3 ? " " + Math.floor(s) + "s" : "");
    };
    go.classList.add("ael-busy");
    go.textContent = label();
    const tick = setInterval(() => {
      const g = B.box && B.box.querySelector(".ael-go");
      const next = label();
      if (g && g.textContent !== next) g.textContent = next;
    }, 250);
    // rehearsal (Options): the whole flow with the live quote, but no call to the service; nothing is
    // locked, written or bought. The panel says so and offers a reset.
    const r =
      S.settings.rehearse === "yes"
        ? await new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: { ok: true, at: new Date().toISOString(), contracts: n, floorCents: t.floorCents, capCents: t.capCents, creditCents: t.creditCents, sideName: shortOf(B.ticker), eventTimeIso: st.quote.p.eventTimeIso, hedge: { simulated: true, fallbackReason: "rehearsal" }, routing: st.quote.p.routing || null, rehearsal: true } }), 3600))
        : await api("/api/shadow/lock", "POST", { ticker: B.ticker, contracts: n, entryCents: (B.size && B.size.entryCents) || undefined, tier: st.tier || undefined, venue: VENUE_ID });
    clearInterval(tick);
    st.busy = false;
    if (!r.ok || !r.json || !r.json.ok) {
      st.quote = { ok: false, code: (r.json && r.json.code) || "lock_failed", message: (r.json && (r.json.message || r.json.error)) || r.error || "The lock did not go through. Nothing changed." };
      paintRow(liveRow(B));
      return;
    }
    st.done = { ticker: B.ticker, at: r.json.at, status: "open", contracts: r.json.contracts, floorCents: r.json.floorCents, capCents: r.json.capCents, creditCents: r.json.creditCents, sideName: r.json.sideName, eventTimeIso: r.json.eventTimeIso, hedge: r.json.hedge || null, routing: r.json.routing || (st.quote && st.quote.p && st.quote.p.routing) || null, justNow: true, ms: Date.now() - t0, rehearsal: Boolean(r.json.rehearsal) };
    st.open = true;
    st.enter = true;
    // a new lock on a game whose earlier protection was removed: the earlier receipt's sale and cash are not this lock's
    st.rcpt = false;
    st.rcptHedge = null;
    st.rcptSale = null;
    st.rcptSaleAsked = false;
    st.rcptCash = null;
    st.leave = null;
    if (r.json.rehearsal) {
      paintRow(liveRow(B));
      return;
    }
    S.record.set(B.ticker, st.done);
    paintRow(liveRow(B));
    setTimeout(loadRecord, 3000);
  };
  /**
   * The row object that stands for this market now. A tap's answer comes seconds later; if the
   * venue redrew the list meanwhile and the scan rebuilt the row, the one the tap was made on is
   * off the page, and painting it would leave the live row on the offer until the next pass.
   */
  const liveRow = (B) => (B.host && B.host.isConnected ? B : [...S.rows.values()].find((o) => o.ticker === B.ticker && o.kind === B.kind && Boolean(o.slip) === Boolean(B.slip) && o.host && o.host.isConnected) || B);

  /**
   * The receipt's detail, under "receipt": what stands behind the terms. Four labelled lines
   * from the service's hedge view (the lock answer at the tap; GET /api/shadow/receipt later):
   * the other side (contracts, side, venue, price with fees), the cost, the venue's order id
   * and time, the record id. A hedge that did not reach the venue reads "covered at the book",
   * no order line; the holder's protection is on the record either way. The reason stays with
   * the operator's hedge line.
   */
  /**
   * Where the other side goes, as the service judged it (GET /api/shadow/quote and the lock answer
   * carry `routing`; the receipt carries the one judged at the tap): the hedge venue and why, each
   * route's cost all in, and the four tails (tie, postponed, called off, corrected) in this venue's
   * own settlement words. The holder sees the venue and the terms; the operator also sees the costs.
   */
  const hedgeVenueOf = (rt) => (rt && rt.hedgeVenueName) || null;
  /**
   * The price competition in one line, as the service words it (`routing.comparison`): what each
   * venue's book would have paid for the same protection and which one the other side went to
   * ("ProphetX $3.10 vs Kalshi $2.40, hedged on ProphetX"). Null when only one venue priced.
   */
  const comparisonOf = (rt) => (rt && typeof rt.comparison === "string" && rt.comparison ? rt.comparison : null);
  /**
   * Grey notes in the offer's fine print: the competition when two venues priced the other side,
   * else where the other side is bought when that is not this page's venue.
   */
  const routingNotes = (rt) => {
    const cmp = comparisonOf(rt);
    if (cmp) return [esc(cmp)];
    const v = hedgeVenueOf(rt);
    if (!v || !rt.holderVenueName || v === rt.holderVenueName) return [];
    return ["other side on " + esc(v)];
  };
  /** How many venues the strip shows at most; the rest of the race stays on the operator's receipt. */
  const VENUE_CHIPS_MAX = 3;
  /**
   * The routes that priced the other side, best credit first; the chosen one flagged. Capped at
   * VENUE_CHIPS_MAX: the venue the hedge goes to and this page's own venue (when it is one of the
   * books in the race) always stay, the best of the rest fill the remaining places. The holder
   * knows where they are, so the home venue is not labelled; it is simply there with its price.
   */
  /**
   * Two words for a venue that priced nothing, on its muted chip: the aggregator has no mapping
   * for the game there, the venue has no listing, or its book could not take the size. The
   * service's full sentence is the chip's tooltip.
   */
  const unpricedWord = (r) => {
    const why = String((r && (r.refusal || r.gate)) || "").toLowerCase();
    if (/not mapped/.test(why)) return "not mapped";
    if (/not list|no listing|does not offer/.test(why)) return "not listed";
    if (/closes before|closed/.test(why)) return "closed";
    return "no price";
  };
  /**
   * The chips in the race: every venue that priced the other side, best credit first, the one the
   * hedge goes to and this page's own venue always kept, VENUE_CHIPS_MAX at most; then, when this
   * page's own venue priced nothing, that venue as a muted chip with the two-word reason (the
   * holder always sees the venue they are standing on; a missing chip would read as a missing
   * venue). A muted chip has no creditCents.
   */
  const pricedRoutes = (rt) => {
    if (!rt || !Array.isArray(rt.routes)) return [];
    const chosen = rt.hedgeVenueName || null;
    const home = rt.holderVenueName || null;
    const all = rt.routes
      .filter((r) => r && r.creditCents != null && r.hedgeVenueName)
      .map((r) => ({ venue: r.hedgeVenueName, creditCents: r.creditCents, chosen: r.hedgeVenueName === chosen }))
      .sort((a, b) => b.creditCents - a.creditCents || (a.chosen ? -1 : 1));
    const homeUnpriced = home && !all.some((r) => r.venue === home) ? rt.routes.find((r) => r && r.hedgeVenueName === home) : null;
    const muted = homeUnpriced ? [{ venue: home, creditCents: null, chosen: false, why: unpricedWord(homeUnpriced), detail: String(homeUnpriced.refusal || homeUnpriced.gate || "") }] : [];
    if (all.length <= VENUE_CHIPS_MAX) return all.concat(muted);
    const kept = all.filter((r) => r.chosen || r.venue === home);
    for (const r of all) {
      if (kept.length >= VENUE_CHIPS_MAX) break;
      if (!kept.includes(r)) kept.push(r);
    }
    return kept.sort((a, b) => b.creditCents - a.creditCents || (a.chosen ? -1 : 1)).concat(muted);
  };
  /** How many venues priced the other side (muted chips do not count). */
  const pricedCount = (rt) => pricedRoutes(rt).filter((r) => r.creditCents != null).length;
  /** One chip: a priced venue with its credit (the winner in the accent, shielded when `shield`), or a muted venue with its two words. */
  const venueChip = (r, shield) => {
    if (r.creditCents == null) return '<span class="ael-vchip ael-mute"' + (r.detail ? ' title="' + esc(r.detail) + '"' : "") + ">" + esc(r.venue) + ' <span class="ael-why">&middot; ' + esc(r.why) + "</span></span>";
    return '<span class="ael-vchip' + (r.chosen ? " ael-won" : "") + '">' + (shield && r.chosen ? '<span class="ael-ic">' + SHIELD_FILL + "</span>" : "") + esc(r.venue) + " <b>" + esc(usd(r.creditCents)) + "</b></span>";
  };
  /**
   * The venue pick, shown, not footnoted: each venue that priced the other side with what it would
   * have paid the holder for the same protection, the one the hedge goes to marked; this page's own
   * venue muted with the reason when it priced nothing. One venue priced and nothing to mute reads
   * "Other side on Kalshi". Nothing when the service sent no routing.
   */
  const venuePick = (rt) => {
    const v = hedgeVenueOf(rt);
    if (!v) return "";
    const routes = pricedRoutes(rt);
    if (routes.length < 2) return '<div class="ael-venues"><span class="ael-l">Other side</span><span class="ael-vchip ael-won"><span class="ael-ic">' + SHIELD_FILL + "</span>" + esc(v) + "</span></div>";
    return '<div class="ael-venues"><span class="ael-l">Other side</span>' + routes.map((r) => venueChip(r, true)).join("") + "</div>";
  };
  /** How much more the chosen venue pays the holder than the next priced one, in cents; null without two prices. */
  const venueEdgeCents = (rt) => {
    const routes = pricedRoutes(rt);
    const won = routes.find((r) => r.chosen);
    const other = routes.find((r) => !r.chosen && r.creditCents != null);
    return won && other ? won.creditCents - other.creditCents : null;
  };
  const bps = (x) => (x == null ? "" : (x >= 0 ? "+" : "") + Math.round(x) + " bps");
  /** The four tails in a few words, for the folded rules line: what the venue's rules cover. */
  const TAIL_WORDS = { tie: "tie", postponed: "postponement", abandoned: "called off", corrected: "corrected result" };
  const tailSummary = (tails) => {
    const words = tails.map((t) => TAIL_WORDS[t.branch]).filter(Boolean);
    return words.length ? words.join(" \u00b7 ") : tails.length + " cases";
  };
  /**
   * The receipt's routing rows, in the story's order: "Hedged on" (the venue; the service's reason
   * is the operator's) and the competition when two venues priced the other side (routeHeadRows);
   * then, after the order itself, the rules as the grid behind a toggle (`rulesOpen`), the pinned
   * terms, and (operator) every route's cost (rulesRows).
   */
  const routeHeadRows = (row, rt) => {
    if (!rt) return "";
    const lines = [];
    const v = hedgeVenueOf(rt);
    if (v) lines.push(row("Hedged on", esc(v) + (operator() && rt.reason ? ' <span class="ael-dim">&middot; ' + esc(rt.reason) + "</span>" : "")));
    // the competition as chips (each venue's credit for the same protection, the winner marked) and the edge in dollars
    const routes = pricedRoutes(rt);
    if (routes.length > 1) {
      const edge = venueEdgeCents(rt);
      lines.push(
        row(
          "Compared",
          '<span class="ael-vchips">' + routes.map((r) => venueChip(r, false)).join("") + (edge > 0 ? '<span class="ael-dim ael-edge">' + esc(usd(edge)) + " more for you</span>" : "") + "</span>",
        ),
      );
    } else {
      const cmp = comparisonOf(rt);
      if (cmp) lines.push(row("Compared", esc(cmp)));
    }
    return lines.join("");
  };
  /** A day on its own ("Oct 28") for a date-only read stamp; a timestamp prints as fmtAt. */
  const fmtRead = (iso) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(iso))) return fmtAt(iso);
    try {
      return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "America/New_York" });
    } catch {
      return String(iso);
    }
  };
  /**
   * The terms row: which rule text the record pinned at the lock, when, and what the second read
   * at settlement found. The fingerprint is the tooltip; the words link to the venue's own page.
   * A market pin (Kalshi) reads "pinned Fri 7:02pm ET"; a pin of the holder's venue's published
   * rules (ProphetX, Novig: basis "rules", the four sentences the Rules grid shows) names the venue
   * and the day the sentences were read ("ProphetX rules read Oct 28"). A pin of another venue's
   * text (the reference market) names that venue.
   */
  const termsRow = (row, rule, holderVenue) => {
    if (!rule) return "";
    const published = rule.basis === "rules";
    const vname = rule.venueName || venueNameOf(rule.venue);
    const whose = rule.venue && holderVenue && rule.venue !== holderVenue ? esc(vname) + "'s rules " : published ? esc(vname) + " rules " : "";
    let words, note;
    if (rule.unchanged === true) {
      words = whose + "held";
      note = published ? "the published rules at the lock and at settlement, same words" : "read at the lock and again at settlement, same words";
    } else if (rule.unchanged === false) {
      words = whose ? whose.replace(/ $/, "") + ": edited by the venue" : "venue edited its rules";
      note = "the payout followed the official result; the words at the lock are on the record";
    } else {
      words = whose + (published ? "read" : "pinned") + (rule.readAtIso ? " " + esc(fmtRead(rule.readAtIso)) : "");
      note = published ? "the sentences under Rules; checked again at settlement" : "checked again at settlement";
    }
    const linked = rule.sourceUrl ? '<a href="' + esc(rule.sourceUrl) + '" target="_blank" rel="noopener" class="ael-terms-a">' + words + "</a>" : words;
    return row("Terms", "<span" + (rule.sha256 ? ' title="fingerprint sha256 ' + esc(rule.sha256) + '"' : "") + ">" + linked + '</span> <span class="ael-dim">&middot; ' + note + "</span>");
  };
  const rulesRows = (row, rt, rulesOpen, rule) => {
    const lines = [];
    if (rt && Array.isArray(rt.tails) && rt.tails.length) {
      lines.push(row(toggleA("ael-rules-a", "Rules", rulesOpen), rulesOpen ? "" : '<span class="ael-dim">' + esc(tailSummary(rt.tails)) + "</span>"));
      if (rulesOpen) lines.push('<div class="ael-rcpt-wide">' + rulesGrid(rt) + "</div>");
    }
    lines.push(termsRow(row, rule, rt ? rt.holderVenue : null));
    if (rt && operator() && Array.isArray(rt.routes)) {
      for (const r of rt.routes) {
        const name = esc(r.hedgeVenueName || (r.hedgeVenue === "polymarket" ? "Polymarket" : r.hedgeVenue === "prophetx" ? "ProphetX" : "Kalshi"));
        const credit = r.creditCents != null ? " &middot; pays " + esc(usd(r.creditCents)) : "";
        lines.push(row(name, r.ok ? esc(bps(r.allInBps)) + ' <span class="ael-dim">all in (' + esc(bps(r.evCostBps)) + " books, " + esc(bps(r.tailChargeBps)) + " tails)" + credit + (r.gate ? " &middot; " + esc(r.gate) : "") + (r.compatible === false ? " &middot; tails differ" : "") + "</span>" : '<span class="ael-dim">' + esc(r.refusal || r.gate || "not offered") + "</span>"));
      }
    }
    return lines.join("");
  };
  /** A sale on ProphetX is an offset: the other side's pair bought, settling against the hedge at the game (the service marks it settlesAtGame). */
  const isOffset = (sale) => Boolean(sale && (sale.settlesAtGame || /prophetx/i.test(String(sale.venue || ""))));
  /** The sale of the other side at a leave, as the receipt has it (hedgeSale): sent to the venue, or on the record for the operator's hand. */
  const saleRow = (row, sale, rec) => {
    const sent = sale ? !sale.simulated : rec && rec.closeHedge ? Boolean(rec.closeHedge.sent) : null;
    if (sent === null && !sale) return "";
    const venue = (sale && sale.venue) || "Kalshi";
    const units = sale && sale.unitsMilli != null ? (sale.unitsMilli / 1000).toFixed(2).replace(/\.00$/, "") : null;
    const order = sale && sale.orderId ? ' <span class="ael-dim">&middot; order <code>' + esc(String(sale.orderId).slice(0, 8)) + "&hellip;</code></span>" : "";
    if (sent && isOffset(sale)) {
      // ProphetX takes no sell order: the other side is offset by buying its pair, which settles at the game
      return row("Offset on", esc(venue) + (units ? " &middot; " + esc(units) + " contracts of the pair bought" : "") + (sale && sale.costCents != null ? " &middot; " + esc(usd(sale.costCents)) + " at the game" : "") + ' <span class="ael-dim">&middot; the pair settles when the game does</span>' + order);
    }
    if (sent) {
      return row("Sold back", (units ? esc(units) + " contracts on " : "on ") + esc(venue) + (sale && sale.avgPriceMilli != null ? " at " + esc((sale.avgPriceMilli / 10).toFixed(1)) + "c each after fees" : "") + (sale && sale.costCents != null ? " &middot; " + esc(usd(sale.costCents)) : "") + order);
    }
    if (isOffset(sale) || /prophetx/i.test(venue)) return row("Offset on", '<span class="ael-dim">' + esc(venue) + "; recorded at the book's price, the pair bought by hand</span>");
    return row("Sold back", '<span class="ael-dim">recorded at the book\'s price on ' + esc(venue) + "; settled by hand</span>");
  };
  /** How the order reached the venue, as the receipt says it: through the aggregator's pod, or on our own key. The partner is never named. */
  const viaWords = (h) => (h && h.via === "aggregator" ? ' <span class="ael-dim">&middot; through the aggregator</span>' : h && h.via === "direct" ? ' <span class="ael-dim">&middot; direct</span>' : "");
  const receiptHtml = (st, rec) => {
    const h = st.rcptHedge || rec.hedge || null;
    const row = (k, v) => "<span>" + k + "</span><b>" + v + "</b>";
    if (rec.rehearsal) {
      return (
        '<div class="ael-rcpt">' +
        row("Other side", 'the other side, priced at the hedge book <span class="ael-dim">(rehearsal, nothing bought)</span>') +
        row("Order", '<span class="ael-dim">none; this was a rehearsal</span>') +
        row("Record", '<span class="ael-dim">not written</span>') +
        "</div>"
      );
    }
    const rt = st.rcptRouting || rec.routing || null;
    const lines = [routeHeadRows(row, rt)];
    if (st.rcptBusy && !h) lines.push(row("Receipt", '<span class="ael-dim">reading&hellip;</span>'));
    else if (!h) lines.push(row("Receipt", '<span class="ael-dim">' + esc(st.rcptErr || "not available right now") + "</span>"));
    else {
      const units = h.unitsMilli != null ? (h.unitsMilli / 1000).toFixed(2).replace(/\.00$/, "") : null;
      const venue = h.venue || "Kalshi";
      // Kalshi holds the other side as No on the club; any other book holds it as the other club
      const side = /kalshi/i.test(venue) ? "No on " + esc(venue) : "the other side on " + esc(venue);
      if (h.simulated) {
        // nothing reached the venue: say so, and (operator) the rail or fallback that held it
        const why = operator() && h.fallbackReason ? ' <span class="ael-dim">&middot; ' + esc(String(h.fallbackReason)) + "</span>" : "";
        lines.push(row("Other side", (units ? esc(units) + " contracts " : "") + "priced at " + esc(venue) + "'s book" + (h.costCents != null ? " &middot; " + esc(usd(h.costCents)) : "")));
        lines.push(row("Order", '<span class="ael-dim">not sent; covered at the book</span>' + why));
      } else {
        lines.push(row("Other side", esc(units || "") + " contracts " + side + (h.avgPriceMilli != null ? " at " + esc((h.avgPriceMilli / 10).toFixed(1)) + "c each with fees" : "")));
        if (h.costCents != null) lines.push(row("Cost", esc(usd(h.costCents)) + ' <span class="ael-dim">all in</span>'));
        if (h.orderId) lines.push(row("Order", "<code>" + esc(String(h.orderId).slice(0, 8)) + "&hellip;</code> " + esc(venue) + viaWords(h) + (h.at ? ' <span class="ael-dim">&middot; ' + esc(fmtAt(h.at)) + "</span>" : "")));
      }
      // the record's own id is the operator's handle; the holder has the order
      if (operator() && h.receiptId) lines.push(row("Record", "<code>" + esc(h.receiptId) + "</code>"));
    }
    if (rec.status === "closed") lines.push(saleRow(row, st.rcptSale || null, rec));
    lines.push(rulesRows(row, rt, Boolean(st.rcptRules), st.rcptRule || rec.rule || null));
    // the money between the two parties, leg by leg, as the record has it: the credit from the
    // tap, and at settlement the floor to the holder or the slice above the cap back to the writer
    const legs = Array.isArray(st.rcptCash) && st.rcptCash.length ? st.rcptCash : Array.isArray(rec.cashDue) ? rec.cashDue : [];
    for (const l of legs) if (LEG_WORDS[l.leg]) lines.push(row(LEG_WORDS[l.leg], legLine(l)));
    return '<div class="ael-rcpt">' + lines.filter(Boolean).join("") + "</div>";
  };

  /** Read the hedge view for a lock from the service once, then paint; the tap's own answer is used when present. */
  const loadReceipt = async (B) => {
    const st = stateOf(B);
    if (st.rcptBusy || st.rcptLoaded) return;
    st.rcptBusy = true;
    const r = await api("/api/shadow/receipt?ticker=" + encodeURIComponent(B.ticker), "GET");
    st.rcptBusy = false;
    if (r.ok && r.json && r.json.ok) {
      st.rcptLoaded = true;
      // the tap's own hedge view stands when the trail has none yet
      st.rcptHedge = r.json.hedge || st.rcptHedge || null;
      st.rcptRouting = r.json.routing || null;
      st.rcptRule = r.json.rule || null;
      st.rcptSale = r.json.hedgeSale || null;
      st.rcptCash = Array.isArray(r.json.cash) ? r.json.cash : null;
      st.rcptErr = st.rcptHedge ? "" : "no hedge on the trail for this lock";
    } else st.rcptErr = (r.json && (r.json.message || r.json.error)) || r.error || "could not read the receipt";
    paintRow(B);
  };

  /** The protected position's details: only what the holder needs to see the deal they have. */
  const paintDetails = (B, panel, rec) => {
    const st = stateOf(B);
    // the hedge behind the receipt: the tap's own answer, kept once seen (the record refresh a
    // moment later carries none), else read from the service the first time the receipt opens
    if (!st.rcptHedge && rec.hedge && rec.hedge.receiptId) st.rcptHedge = rec.hedge;
    // one read of the receipt when the tap's answer is not enough: no hedge view, or no pinned rule for the Terms row
    if (st.rcpt && !rec.rehearsal && !st.rcptLoaded && !st.rcptBusy && !st.rcptErr && (!st.rcptHedge || !(st.rcptRule || rec.rule))) void loadReceipt(B);
    // left early: the sale of the other side is on the receipt; read it once
    if (st.rcpt && rec.status === "closed" && !rec.rehearsal && !st.rcptSale && !st.rcptBusy && !st.rcptSaleAsked) {
      st.rcptSaleAsked = true;
      st.rcptHedge = null;
      st.rcptLoaded = false;
      void loadReceipt(B);
    }
    const rs = outcomes(B, rec.contracts, rec.floorCents, rec.capCents, rec.creditCents);
    const nick = shortOf(B.ticker);
    const h = st.rcptHedge || rec.hedge;
    const opLine =
      S.settings.showHedge === "yes" && h
        ? '<div class="ael-op">' + (h.simulated ? "hedge held: " + esc(h.fallbackReason || "simulated") : "hedged live on " + esc(h.venue || "Kalshi") + (h.via ? " via " + esc(h.via) : "") + " &middot; order " + esc(h.orderId || "") + " &middot; " + (h.costCents != null ? esc(usd(h.costCents)) : "")) + "</div>"
        : "";
    // the same slip as the offer, with the locked numbers and no button; then one grey line of
    // facts ending in the receipt link. Nothing left to choose, nothing to manage.
    let body;
    const meta = [];
    if (rec.status === "settled" && rec.result) {
      const got = rec.protectedCents != null ? rec.protectedCents : rec.result === "yes" ? rs.capTotal : rs.floorTotal;
      const naked = rec.result !== "yes" ? 0 : rec.nakedCents != null ? rec.nakedCents : centsOf(100, rec.contracts);
      // "you end with", not "you received": whether the cash has moved is its own row
      const cash = cashState(rec);
      body =
        '<div class="ael-ledger ael-two">' +
        ledgerRow(esc(nick) + (rec.result === "yes" ? " won" : " lost") + " &middot; you end with", esc(usd(got)), null, "ael-hero") +
        ledgerRow("Unprotected, it would have paid", esc(usd(naked)), null, cash ? "" : "ael-last") +
        (cash ? ledgerRow("Cash", cash.label, null, "ael-last") : "") +
        "</div>";
      if (rec.settledAt) meta.push("Settled " + esc(fmtAt(rec.settledAt)));
      if (cash && cash.open) meta.push(rec.result === "yes" ? "the slice above the cap goes back to the writer; the receipt shows each leg" : "the floor comes to you; the receipt shows each leg");
    } else if (rec.status === "void") {
      body = '<div class="ael-ph"><b>Protection voided</b><span>No official result for this game; nothing owed either way.</span></div>';
    } else if (rec.status === "closed") {
      // protection removed: the protection alone settled between us at that moment's price; the pick
      // is the holder's and stays open on the venue. The cash row says whether the settlement has moved.
      const net = closeNetOf(rec);
      const cash = cashState(rec);
      body =
        '<div class="ael-ledger ael-two">' +
        ledgerRow("Protection removed &middot; settled <span class=\"ael-dim\">" + closeWhy(net) + "</span>", signed(net), null, "ael-hero") +
        ledgerRow("Your pick", "open on " + esc(V.name) + ", unprotected", null, cash ? "" : "ael-last") +
        (cash ? ledgerRow("Cash", cash.label, null, "ael-last") : "") +
        "</div>";
      if (rec.closedAt) meta.push("Removed " + esc(fmtAt(rec.closedAt)));
      if (operator() && rec.closeUnwindFrictionCents != null) meta.push("crossing the books cost " + esc(usd(rec.closeUnwindFrictionCents)) + " against the mid");
      if (rec.closeHedge) {
        const sale = rec.closeHedge.sale || null;
        meta.push(!rec.closeHedge.sent ? "the other side's sale is on the record" : isOffset(sale) ? "the other side offset on " + esc(sale.venue) + ", settles at the game" : "the other side sold on " + esc((sale && sale.venue) || "Kalshi"));
      }
      if (rec.justLeft && rec.ms) meta.push("in " + (rec.ms / 1000).toFixed(1) + "s");
      if (cash && cash.open) meta.push(net < 0 ? "the settlement goes back to the writer; the receipt shows each leg" : "the settlement comes to you; the receipt shows each leg");
      if (rec.rehearsal) meta.push("rehearsal");
    } else {
      // leaving is the one thing left to do: a quiet button under the slip, in the venue's raised
      // grey rather than our colour, with what it means beside it; the leave block takes its place.
      // A rehearsal has it too, priced from the live mark (rehearsedLeave), so the whole flow can be walked.
      // simple layout: the Details toggle shares the row with the pill, and the pill's meaning waits
      // for the leave sheet (its header says it); the receipt waits behind Details
      const detailsA = simple() ? '<span class="ael-links">' + toggleA("ael-rcpt-a", "Details", st.rcpt) + "</span>" : "";
      const leaveAct = !st.leave ? '<div class="ael-acts' + (simple() ? " ael-offer-acts" : "") + '"><button type="button" class="ael-go ael-quiet ael-leave-a">Leave early</button>' + (simple() ? "" : "<span>remove the protection, keep your pick</span>") + detailsA + "</div>" : detailsA ? '<div class="ael-acts ael-offer-acts">' + detailsA + "</div>" : "";
      body = (simple() ? simpleLedger(nick, rs, rec.creditCents, null) : ledger(nick, rs, rec.creditCents, null)) + (st.leave ? leaveHtml(B, rec, rs) + leaveAct : leaveAct);
      if (rec.at) meta.push("Locked " + esc(fmtAt(rec.at)));
      if (rec.justNow && rec.ms) meta.push((rec.hedge && !rec.hedge.simulated ? "the other side bought in " : "in ") + (rec.ms / 1000).toFixed(1) + "s");
      if (rec.rehearsal) meta.push("rehearsal");
    }
    // the receipt's detail is one tap away, never in the way. Simple layout: the facts line stays in
    // view (the lock's moment is the tap's proof) and the Details toggle sits under the slip, in the
    // pill's row when there is one. Full layout: a "receipt" link at the end of the facts line.
    const detailsRow = simple() && rec.status !== "void" && rec.status !== "open" ? '<div class="ael-acts ael-offer-acts"><span class="ael-links">' + toggleA("ael-rcpt-a", "Details", st.rcpt) + "</span></div>" : "";
    if (rec.status !== "void" && !simple()) meta.push('<a href="#" class="ael-rcpt-a">' + (st.rcpt ? "hide receipt" : "receipt") + "</a>");
    const recordUrl = (S.baseUrl || "").replace(/\/+$/, "") + "/";
    const metaLine = meta.length ? '<div class="ael-meta">' + meta.join(" &middot; ") + "</div>" : "";
    const html =
      body +
      metaLine +
      detailsRow +
      (st.rcpt && rec.status !== "void" ? receiptHtml(st, rec) : "") +
      opLine +
      (rec.rehearsal ? '<div class="ael-op">Rehearsal: nothing was locked, written or bought. <a href="#" class="ael-reset-a">Reset</a></div>' : "") +
      (operator() ? '<div class="ael-fine"><a href="' + esc(recordUrl) + '" target="_blank" rel="noopener">public record</a></div>' : "") +
      DISCLOSE;
    setPanel(B, panel, html, () => {
      const reset = panel.querySelector(".ael-reset-a");
      if (reset)
        reset.onclick = (e) => {
          e.preventDefault();
          const st = stateOf(B);
          st.done = null;
          st.open = false;
          st.quoteAt = 0;
          st.rcpt = false;
          st.rcptHedge = null;
          st.rcptRule = null;
          st.rcptLoaded = false;
          st.leave = null;
          st.flashed = false;
          paintRow(B);
        };
      const rcpt = panel.querySelector(".ael-rcpt-a");
      if (rcpt)
        rcpt.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const st = stateOf(B);
          st.rcpt = !st.rcpt;
          if (st.rcpt) st.rcptErr = "";
          paintRow(B);
        };
      const rules = panel.querySelector(".ael-rules-a");
      if (rules)
        rules.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          const st = stateOf(B);
          st.rcptRules = !st.rcptRules;
          paintRow(B);
        };
      const leave = panel.querySelector(".ael-leave-a");
      if (leave)
        leave.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          stateOf(B).leave = { at: 0 };
          paintRow(B);
        };
      const stay = panel.querySelector(".ael-stay");
      if (stay)
        stay.onclick = () => {
          stateOf(B).leave = null;
          paintRow(B);
        };
      const go = panel.querySelector(".ael-leave-go");
      if (go) go.onclick = () => leaveNow(B, rec);
    });
  };

  // ── leaving early ─────────────────────────────────────────────────────────────────────────
  // A protected position can be left before the start: the protection settles at today's price
  // instead of the official result. The service prices it from the live books (the pick sold
  // into its bids, our hedge sold into its), the holder reads the figures, then taps once more;
  // the tap prices again. Nothing is reversed: it is a new trade at live prices, the record says so.

  /** Read the live leave quote once, then again when it has gone stale while the block is open. */
  const leaveQuote = (B) => {
    const st = stateOf(B);
    const L = st.leave;
    if (!L || L.busy || L.sending) return;
    if (L.q && Date.now() - L.at < REQUOTE_MS) return;
    L.busy = true;
    if (st.done && st.done.rehearsal) {
      // rehearsal: no lock exists at the service to price a leave of. The live mark is read from a
      // fresh quote (a read, nothing written) and the settlement estimated from it
      const rec = st.done;
      const path = "/api/shadow/quote?ticker=" + encodeURIComponent(B.ticker) + "&contracts=" + rec.contracts + "&venue=" + encodeURIComponent(VENUE_ID);
      api(path, "GET").then((r) => {
        const st2 = stateOf(B);
        if (!st2.leave) return;
        st2.leave.busy = false;
        st2.leave.at = Date.now();
        const live = r.ok && r.json && typeof r.json.markCents === "number" ? r.json.markCents : null;
        const was = st2.quote && st2.quote.ok && st2.quote.p ? st2.quote.p.markCents : null;
        const q = rehearsedLeave(rec, live != null ? live : was);
        st2.leave = q ? { ...st2.leave, q, lastIso: null, err: null } : { ...st2.leave, q: null, err: { why: "The live price is not in yet.", next: "A moment." } };
        paintRow(B);
      });
      return;
    }
    api("/api/shadow/unwind/quote?ticker=" + encodeURIComponent(B.ticker), "GET").then((r) => {
      const st2 = stateOf(B);
      if (!st2.leave) return;
      st2.leave.busy = false;
      st2.leave.at = Date.now();
      if (r.ok && r.json && r.json.ok && r.json.unwind) st2.leave = { ...st2.leave, q: r.json.unwind, lastIso: r.json.lastIso || null, err: null };
      else st2.leave = { ...st2.leave, q: null, err: leaveWords(r) };
      paintRow(B);
    });
  };

  /**
   * A leave priced from the mark alone, for a rehearsal (nothing is on the books to sell). The same
   * shape the service answers with: the hedge's sale (the other side's units at a cent inside the
   * mark) less the cap slice sold at the tap is the settlement; the position's sale a cent inside.
   */
  const rehearsedLeave = (rec, markCents) => {
    if (typeof markCents !== "number" || !(markCents > 0 && markCents < 100)) return null;
    const n = rec.contracts;
    const yesBid = Math.max(1, markCents - 1);
    const noBid = Math.max(1, 99 - markCents);
    const hedgeUnits = ((rec.floorCents + 100 - rec.capCents) * n) / 100;
    const hedgeProceedsCents = Math.round(hedgeUnits * noBid);
    const fundingCents = Math.floor((100 - rec.capCents) * n);
    const positionProceedsCents = Math.round(n * yesBid);
    return {
      closeNetCents: hedgeProceedsCents - fundingCents,
      protectedAtCloseCents: positionProceedsCents + hedgeProceedsCents - fundingCents + rec.creditCents,
      nakedAtCloseCents: positionProceedsCents,
      yesFillCents: yesBid,
      yesMidCents: markCents,
      unwindFrictionCents: null,
      creditCents: rec.creditCents,
      rehearsal: true,
    };
  };

  /** Plain words for a leave that cannot happen now. */
  const leaveWords = (r) => {
    const j = (r && r.json) || {};
    if (!r || !r.ok || !j) return { why: "Live pricing is unavailable right now.", next: "Try again in a moment." };
    switch (j.error || j.code) {
      case "too_late":
        return { why: "Too late to leave; the start is close.", next: "The protection runs to the official result now." + (j.lastIso ? " Leaving closed " + fmtAt(j.lastIso) + "." : "") };
      case "not_open":
        return { why: j.status === "closed" ? "This position was already left." : "This position has settled.", next: "" };
      case "book_empty":
      case "book_too_thin":
        return { why: (j.leg === "hedge" ? "The hedge's" : "Your side's") + " book cannot take the size right now.", next: "Check back in a few minutes; the book refills." };
      case "lock_in_flight":
        return { why: "This position is being written right now.", next: "A moment." };
      default:
        return { why: j.message || "Leaving is unavailable right now.", next: "" };
    }
  };

  /** The leave block under the slip: the live figures, the two ways out, the fine print. */
  const leaveHtml = (B, rec, rs) => {
    const st = stateOf(B);
    const L = st.leave;
    if (!L.q && !L.err) {
      // the first read is on its way
      if (!L.busy) setTimeout(() => leaveQuote(B), 0);
      return '<div class="ael-leave"><div class="ael-skel"></div><div class="ael-skel" style="width:70%"></div></div>';
    }
    if (!L.q) {
      return '<div class="ael-leave"><div class="ael-ph"><b>' + esc(L.err.why) + "</b>" + (L.err.next ? "<span>" + esc(L.err.next) + "</span>" : "") + '</div><div class="ael-leave-acts"><button type="button" class="ael-go ael-quiet ael-stay">Back</button></div></div>';
    }
    if (Date.now() - L.at >= REQUOTE_MS) setTimeout(() => leaveQuote(B), 0);
    const q = L.q;
    const net = q.closeNetCents;
    const fine = [q.rehearsal ? "Rehearsal &middot; estimated from the live mark, not the books; nothing is sold" : "Priced live"];
    if (L.lastIso) fine.push("until " + esc(fmtAt(L.lastIso)));
    if (operator() && q.unwindFrictionCents != null) fine.push("crossing the books costs " + esc(usd(q.unwindFrictionCents)) + " against the mid");
    // the protection alone settles; the pick is the holder's and stays where it is. One signed
    // number, with the honest why: up, the upside they sold is worth more; down, the floor they hold is
    return (
      '<div class="ael-leave">' +
      '<div class="ael-leave-h"><b>Leave early</b><span>remove the protection, keep your pick</span></div>' +
      '<div class="ael-ledger ael-two">' +
      ledgerRow("Protection settles <span class=\"ael-dim\">" + closeWhy(net) + "</span>", signed(net) + ' <span class="ael-dim">' + (net < 0 ? "due back" : "to you") + "</span>", null, "ael-hero") +
      ledgerRow("Staying", esc(usd(rs.floorTotal)) + " or " + esc(usd(rs.capTotal)), null, "ael-last") +
      "</div>" +
      '<div class="ael-leave-acts"><button type="button" class="ael-go ael-leave-go">Leave early</button><button type="button" class="ael-go ael-quiet ael-stay">Stay</button></div>' +
      '<div class="ael-fine">' + fine.join(" &middot; ") + "</div>" +
      '<div class="ael-fine">Your pick stays open on ' + esc(V.name) + ", unprotected. The " + esc(usd(q.creditCents)) + " credit paid at the lock is yours; this settlement is separate.</div>" +
      "</div>"
    );
  };

  /** The tap: the service prices again and writes the close; the row becomes Protection removed. */
  const leaveNow = async (B, rec) => {
    const st = stateOf(B);
    const L = st.leave;
    if (!L || L.sending) return;
    L.sending = true;
    const go = B.box.querySelector(".ael-leave-go");
    const stay = B.box.querySelector(".ael-stay");
    if (stay) stay.disabled = true;
    const t0 = Date.now();
    const STAGES = ["Pricing from the live books…", "Writing the record…"];
    const label = () => {
      const s = (Date.now() - t0) / 1000;
      return STAGES[Math.min(STAGES.length - 1, Math.floor(s / 1.5))] + (s >= 3 ? " " + Math.floor(s) + "s" : "");
    };
    if (go) {
      go.disabled = true;
      go.classList.add("ael-busy");
      go.textContent = label();
    }
    const tick = setInterval(() => {
      const g = B.box && B.box.querySelector(".ael-leave-go");
      const next = label();
      if (g && g.textContent !== next) g.textContent = next;
    }, 250);
    // rehearsal: the same stages and the same shape of answer, from the estimate; nothing is sent
    const r = rec.rehearsal
      ? await new Promise((resolve) => setTimeout(() => resolve({ ok: true, json: { ok: true, at: new Date().toISOString(), unwind: L.q, rehearsal: true } }), 3200))
      : await api("/api/shadow/unwind", "POST", { ticker: B.ticker });
    clearInterval(tick);
    const st2 = stateOf(B);
    if (!(r.ok && r.json && r.json.ok && r.json.unwind)) {
      // refused or unreachable: the position is still protected; say why, offer the way back
      st2.leave = { at: Date.now(), q: null, err: leaveWords(r) };
      B.panelHtml = null;
      paintRow(B);
      return;
    }
    const u = r.json.unwind;
    const left = {
      ...rec,
      status: "closed",
      closedAt: r.json.at,
      protectedCents: u.protectedAtCloseCents,
      nakedCents: u.nakedAtCloseCents,
      closeNetCents: u.closeNetCents,
      closeYesFillCents: u.yesFillCents,
      closeUnwindFrictionCents: u.unwindFrictionCents,
      cashDue: Array.isArray(r.json.cash) ? r.json.cash : rec.cashDue,
      closeHedge: r.json.hedge || null,
      justLeft: true,
      ms: Date.now() - t0,
    };
    st2.leave = null;
    if (r.json.hedge && r.json.hedge.sale) st2.rcptSale = r.json.hedge.sale;
    st2.rcptCash = Array.isArray(r.json.cash) ? r.json.cash : st2.rcptCash;
    if (st2.done) st2.done = left;
    st2.enter = true;
    B.panelHtml = null;
    if (rec.rehearsal) {
      // the rehearsed record lives in the row's own state; the service's record never held it
      paintRow(liveRow(B));
      return;
    }
    S.record.set(B.ticker, left);
    paintRow(liveRow(B));
    // the service's word on the game: a service that frees a market left early offers it again, and the row goes back to Lock in
    void loadMarkets();
    setTimeout(loadRecord, 3000);
  };

  // ── before the trade: one pill per protectable game, and the same pill in the slip ───────
  // The service says which games can be locked in right now (markets[].protectable, with the
  // window's close: 45 minutes before kickoff); a game under way or about to start is not on it.
  // The page is read only to find each game's card: the smallest block naming both clubs. One
  // pill per game, in a neutral place (after the game's title, else after its time line, else on
  // its last line), reading "Lock in · until 7:35pm ET": the words are on the mark, no hover
  // needed; the hover card says the rest. The slip gets the same pill with no figures: a price
  // is quoted on the plays page once the play fills, not from a stake typed into a page we do
  // not control.
  const marksOff = () => S.serviceState !== "ok" || (S.ext.marksOff || []).includes(VENUE_ID);
  const marksOn = () => S.settings.showShield === "yes" && !marksOff();
  const slipOn = () => S.settings.showSlip === "yes" && !marksOff();
  /**
   * A market is open to lock in on the service's word (markets[].protectable). A service built
   * before that field (it answers the markets route but not the telemetry one) says only what is
   * already on the record: those rows draw on `!onRecord`, as 0.6 did, with no "until" on the pill.
   */
  const marketOpen = (m) => (m.protectable === undefined ? !m.onRecord : m.protectable === true);
  /** The service's word on a game: open to lock in when either side is, and when the window closes. */
  const gameOpen = (stem) => S.markets.filter((m) => stemOf(m.ticker) === stem && marketOpen(m));
  const gameUntil = (stem) => (gameOpen(stem).find((m) => m.protectableUntilIso) || {}).protectableUntilIso || null;
  const untilWords = (iso) => {
    if (!iso) return "";
    try {
      const d = new Date(iso);
      const et = (x) => x.toLocaleDateString("en-US", { timeZone: "America/New_York" });
      const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }).toLowerCase().replace(" ", "");
      return "until " + (et(d) === et(new Date()) ? "" : d.toLocaleDateString("en-US", { weekday: "short", timeZone: "America/New_York" }) + " ") + time + " ET";
    } catch {
      return "";
    }
  };
  /** How the game starts, in the league's word: kickoff, tip-off, first pitch. */
  const START_WORD = { nfl: "kickoff", nba: "tip-off", mlb: "first pitch" };
  const startWord = (stem) => START_WORD[String((S.markets.find((m) => stemOf(m.ticker) === stem) || {}).league || "").toLowerCase()] || "the start";
  const TIP_WORDS = (stem) => {
    const u = gameUntil(stem);
    return "Protection on this game can be locked in from " + V.page + " after your pick " + (VENUE_ID === "kalshi" ? "fills" : "is matched") + (u ? ", " + untilWords(u) + " (" + (S.ext.cutoffMinutes || 45) + " minutes before " + startWord(stem) + ")." : ".");
  };
  /**
   * The games (ticker stems) a text names both clubs of. A nickname shared by two listed games
   * (this week and next) is settled by the other club: both sides must share one stem.
   */
  const gamesIn = (raw) => {
    const text = spaced(raw);
    // stem -> { sides: Set(ticker), words: Set(the words that named them), named: a nickname was read }
    // Two sides from two words: "LA" alone fits both Los Angeles clubs and must not name their game.
    const seen = new Map();
    if (!S.nickRe) return [];
    let word = 0;
    const add = (ticker, named) => {
      const st = stemOf(ticker);
      const g = seen.get(st) || { sides: new Set(), words: new Set(), named: false };
      g.sides.add(ticker);
      g.words.add(word);
      g.named = g.named || named;
      seen.set(st, g);
    };
    let m;
    const partOfName = new Set(); // where a code that is part of a club's name ends ("LA Rams")
    S.nickRe.lastIndex = 0;
    while ((m = S.nickRe.exec(text))) {
      word++;
      let list = S.nicks.get(m[2].toLowerCase()) || [];
      const before = text.slice(0, m.index + m[1].length).replace(/\s+$/, "");
      const code = /(?:^|[^A-Za-z])([A-Z]{2,3})$/.exec(before);
      if (code) {
        partOfName.add(before.length);
        if (list.length > 1) {
          const hit = list.filter((x) => x.code === code[1] || (CODE_ALIAS[code[1]] || []).includes(x.code));
          if (hit.length) list = hit;
        }
      }
      for (const x of list) add(x.ticker, true);
    }
    // the other club may be printed as its code only ("DET Lions" beside "GB" in a joined cell);
    // a card of codes alone (the score strip) names no game
    CODE_RE.lastIndex = 0;
    while ((m = CODE_RE.exec(text))) {
      if (partOfName.has(m.index + m[0].length)) continue;
      word++;
      for (const t of S.codes.get(m[2]) || []) add(t, false);
    }
    // ...unless the codes are joined as a matchup ("BKN at BOS", "SA SAS at 1-2 NYK"): a board
    // that prints no nicknames at all still names its games that way, and the one listed game
    // both codes share is the card's game
    MATCHUP_RE.lastIndex = 0;
    while ((m = MATCHUP_RE.exec(text))) {
      const away = new Set([m[2], m[3]].filter(Boolean).flatMap((c) => S.codes.get(c) || []));
      const home = new Set([m[4], m[5]].filter(Boolean).flatMap((c) => S.codes.get(c) || []));
      const stems = [...away].map(stemOf).filter((st) => [...home].some((t) => stemOf(t) === st));
      if (new Set(stems).size !== 1) continue;
      const st = stems[0];
      word++;
      for (const t of away) if (stemOf(t) === st) add(t, true);
      word++;
      for (const t of home) if (stemOf(t) === st) add(t, true);
    }
    return [...seen.entries()].filter(([, g]) => g.sides.size >= 2 && g.words.size >= 2 && g.named).map(([st]) => st);
  };
  /**
   * One game out of two the same two clubs play inside the window (a back-to-back, a home-and-home):
   * the card's own words settle it, or nothing is marked. A date names the game on that day; a
   * weekday the game on that weekday; "today", "tonight" or a bare clock time today's game;
   * "tomorrow" tomorrow's; a game under way (LIVE, a quarter, Final) is the earlier of the two,
   * since the later one has not started. Words that fit both games, or neither, settle nothing.
   */
  const settleStems = (stems, raw) => {
    const list = [...new Set(stems)];
    if (!list.length) return null;
    const text = gameWords(raw);
    const one = (hits) => (hits.length === 1 ? hits[0] : null);
    const days = datesIn(text);
    if (list.length === 1) {
      // one listing, but the card prints a day: it names the game on that day or none (a "Dec 25"
      // card of the same two clubs is not this week's game)
      if (days.size && !dayMatches(list[0], days)) return null;
      const wds = weekdaysIn(text);
      const next = gameDate(list[0], 1);
      if (wds.size && !wds.has(weekdayOf(list[0])) && !(next && wds.has(WEEKDAYS[next.getUTCDay()]))) return null;
      return list[0];
    }
    if (days.size) return one(list.filter((s) => dayMatches(s, days)));
    const wds = weekdaysIn(text);
    if (wds.size) return one(list.filter((s) => wds.has(weekdayOf(s))));
    if (TOMORROW_RE.test(text)) return one(list.filter((s) => gameDayOf(s) === dayKey(new Date(Date.now() + 86_400_000))));
    if (TODAY_RE.test(text) || CLOCK_RE.test(text)) return one(list.filter((s) => gameDayOf(s) === dayKey(new Date())));
    if (UNDER_WAY_RE.test(text)) {
      const sorted = [...list].sort((a, b) => gameOrdinal(a) - gameOrdinal(b));
      return gameOrdinal(sorted[0]) < gameOrdinal(sorted[1]) ? sorted[0] : null;
    }
    return null;
  };
  const CARD_MAX_H = 340;
  const CARD_MAX_TEXT = 700;
  const TIME_RE = /\b\d{1,2}:\d{2}\s?(?:[ap]\.?m\.?)?\b|\b(?:today|tomorrow|tonight|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\.? \d{1,2}\b/i;
  /**
   * A block's words with a space between its text nodes. `textContent` runs them together, and
   * a React Native Web page puts a view, not a space, between a club's code and its name ("GB"
   * "Packers") or its name and its record ("Lions" "3-2"): "GBPackers" names no club.
   */
  const wordsOf = (el, max) => {
    let s = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue && n.nodeValue.trim();
      if (!t || OURS(n)) continue;
      s += (s ? " " : "") + t;
      if (s.length > max) break;
    }
    return s;
  };
  /** An element that cuts its one line of text (overflow hidden with nowrap or an ellipsis). */
  const cuts = (e) => {
    const cs = getComputedStyle(e);
    return /hidden|clip/.test(cs.overflowX) && (cs.textOverflow === "ellipsis" || cs.whiteSpace === "nowrap");
  };
  /** A text line the venue cuts with an ellipsis (a sidebar's game list, a "most active" rail): a pill after it would be cut too. */
  const clipped = (node) => {
    let e = node.parentElement;
    for (let i = 0; e && i < 3; i++, e = e.parentElement) if (cuts(e)) return true;
    return false;
  };
  /**
   * The card's time line, if it has one: a short text that is a time, a day or the game's state
   * ("LIVE"), not a club and not a section heading ("Today" over the day's games).
   */
  const STATE_RE = /^(live|in progress|final|started)$/i;
  const timeLine = (card) => {
    const w = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = norm(n.nodeValue);
      if (!t || t.length > 40 || OURS(n)) continue;
      S.nickRe.lastIndex = 0;
      if (S.nickRe.test(t)) continue;
      if ((TIME_RE.test(t) || STATE_RE.test(t)) && !(n.parentElement && n.parentElement.closest("h1,h2,h3,h4,h5,h6"))) return lastOfTimeLine(n);
    }
    return null;
  };
  /**
   * A time line printed as sibling cells ("Today" | "8:05 PM"): the pill follows the last of
   * them, not the first, so the line reads "Today 8:05 PM [Lock in]" and not "Today [Lock in] 8:05 PM".
   */
  const lastOfTimeLine = (n) => {
    let last = n;
    for (let sib = n.parentElement && n.parentElement.nextElementSibling, i = 0; sib && i < 3; sib = sib.nextElementSibling, i++) {
      if (sib.nodeType !== 1 || OURS(sib)) break;
      // the cell's own words, a pill already sitting in it aside
      const w = document.createTreeWalker(sib, NodeFilter.SHOW_TEXT);
      let tn = null;
      let t = "";
      for (let x = w.nextNode(); x; x = w.nextNode()) {
        if (OURS(x) || !norm(x.nodeValue)) continue;
        tn = x;
        t += (t ? " " : "") + norm(x.nodeValue);
      }
      S.nickRe.lastIndex = 0;
      if (!tn || t.length > 40 || !TIME_RE.test(t) || S.nickRe.test(t)) break;
      last = tn;
    }
    return last;
  };
  /**
   * From a text naming one or both clubs, the block that is the game's card: the smallest naming
   * both clubs of exactly one game, grown while the block above still names only that game (the
   * row grid up to the card with its time line) and stopped once it holds a time line, at the
   * list of games, or at a block too tall or too narrow to be one card.
   */
  const climbToCard = (node) => {
    let card = null;
    let stem = null;
    let e = node.parentElement;
    for (let i = 0; e && e !== document.body && i < 14; i++, e = e.parentElement) {
      const t = wordsOf(e, CARD_MAX_TEXT);
      if (t.length > CARD_MAX_TEXT) break;
      const games = gamesIn(t);
      if (!games.length) continue;
      // the same two clubs twice in the window: this block's own date, weekday or state picks the
      // game; one listing under a day that is not its own is not it either
      const one = settleStems(games, t);
      // the block names this one game under a day that is not its own: no card at all
      if (!one && games.length === 1) return null;
      if (!one) break;
      if (stem && one !== stem) break;
      const r = e.getBoundingClientRect();
      if (r.height > CARD_MAX_H || r.width < 120) break;
      // a block that brings in a heading the card had none of is the day's section, not the card
      if (card && !card.querySelector("h1,h2,h3,h4,h5,h6") && e.querySelector("h1,h2,h3,h4,h5,h6")) break;
      card = e;
      stem = one;
      if (timeLine(e)) break;
    }
    return card ? { stem, card } : null;
  };
  /**
   * Every game on the page: stem -> where the pill goes. Each text naming a club offers a spot,
   * ranked; the best spot per game wins, the first in the page on a tie:
   *   0  a whole title the venue does not cut ("KC Chiefs vs SEA Seahawks"), the pill right after it
   *   1  the card climbed to from one club's name
   *   2  beside the first club named, when no card can be told apart (one pill per game still)
   */
  const findGames = (nodes) => {
    const best = new Map();
    if (!S.nickRe) return best;
    const offer = (stem, rank, spot) => {
      const have = best.get(stem);
      if (!have || rank < have.rank) best.set(stem, { rank, ...spot });
    };
    const slipBlock = S.slip && S.slip.block;
    for (const node of nodes) {
      const text = norm(node.nodeValue);
      if (!text || text.length > 80 || OURS(node)) continue;
      S.nickRe.lastIndex = 0;
      const named = S.nickRe.test(text);
      // a board of codes alone ("BKN at BOS"): a bare listed code is the way into its card, and only
      // the card (its matchup line) can name the game
      if (!named && !(/^[A-Z]{2,3}$/.test(text) && S.codes.has(text))) continue;
      // the slip has its own line
      if (slipBlock && slipBlock.contains(node)) continue;
      if (!named) {
        const c = climbToCard(node);
        if (c) offer(c.stem, 1, { anchor: null, card: c.card });
        continue;
      }
      const titled = gamesIn(text);
      if (titled.length) {
        // two listings of the same two clubs: the title's own date or weekday says which, else neither
        const one = settleStems(titled, text);
        // a cut title is a list entry (a sidebar, a "most active" rail), not the game's card
        if (one && !clipped(node)) offer(one, 0, { anchor: node, card: null });
        continue;
      }
      const c = climbToCard(node);
      if (c) offer(c.stem, 1, { anchor: null, card: c.card });
      else {
        // the club's own tickers; only a name that fits one listed game, or whose line says which
        // of the club's games ("Pistons · Tue 7:00 PM"), can carry a pill
        S.nickRe.lastIndex = 0;
        const m = S.nickRe.exec(text);
        const list = m ? S.nicks.get(m[2].toLowerCase()) || [] : [];
        const stems = [...new Set(list.map((x) => stemOf(x.ticker)))];
        const one = settleStems(stems, text);
        // a label, not a sentence: a club named in running text carries nothing
        if (one && text.length <= 40) offer(one, 2, { anchor: node, card: null });
      }
    }
    return best;
  };
  /** Where a card's pill sits: after its time line, else on its last line. */
  const cardSpot = (card) => {
    const n = timeLine(card);
    // no time line: a line of our own at the foot of the card
    return n ? { anchor: n, card } : { anchor: null, card };
  };
  /** The node the pill follows: the anchor text, or its badge when the text is all the badge holds ("12:15 AM" in a rounded chip). */
  const pillAfter = (spot) => {
    let after = spot.anchor;
    for (let i = 0; i < 4; i++) {
      const p = after.parentNode;
      if (!p || p === spot.card || p === document.body || !p.parentNode) break;
      const lone = p.childNodes.length === 1;
      // out of a chip or wrapper that holds this text alone, and out of any line that cuts its text
      // (a pill inside it would be cut): one that is a block holding other things too is the line itself
      if ((lone && !/^(DIV|P|LI|TD|TH|SECTION|ARTICLE|H[1-6])$/.test(p.tagName)) || (p.nodeType === 1 && cuts(p))) after = p;
      else break;
    }
    return after;
  };
  /** The pill has room: a size of its own, and not cut off by an ancestor that hides its overflow (the page's own scroll box aside). */
  const shows = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 24 || r.height < 10) return false;
    for (let e = el.parentElement, i = 0; e && e !== document.body && i < 12; e = e.parentElement, i++) {
      const cs = getComputedStyle(e);
      if (!/hidden|clip/.test(cs.overflowX) && !/hidden|clip/.test(cs.overflowY)) continue;
      const b = e.getBoundingClientRect();
      if (b.height > window.innerHeight * 0.8) continue;
      if (r.right > b.right + 1 || r.bottom > b.bottom + 1 || r.left < b.left - 1 || r.top < b.top - 1) return false;
    }
    return true;
  };
  const mountPill = (pill, spot) => {
    if (spot.anchor) {
      const after = pillAfter(spot);
      after.parentNode.insertBefore(pill, after.nextSibling);
    } else {
      const row = document.createElement("div");
      row.className = "ael-ui ael-pill-row " + SKIN;
      row.appendChild(pill);
      spot.card.appendChild(row);
    }
  };
  const unmountPill = (el) => (el.parentNode && el.parentNode.classList && el.parentNode.classList.contains("ael-pill-row") ? el.parentNode : el).remove();
  const pillHtml = (stem) => '<span class="ael-ic">' + SHIELD_FILL + "</span><b>Lock in</b>" + (gameUntil(stem) ? '<span class="ael-until">' + esc(untilWords(gameUntil(stem))) + "</span>" : "");
  const stopRow = (el) => {
    // the venue's row is a link or a button: our pill must not fire it
    for (const ev of ["click", "mousedown", "pointerdown", "touchstart"]) el.addEventListener(ev, (e) => { e.stopPropagation(); e.preventDefault(); });
  };
  const newPill = (stem) => {
    const pill = document.createElement("span");
    pill.className = "ael-ui ael-pill " + SKIN;
    pill.dataset.aelGame = stem;
    pill.setAttribute("role", "note");
    pill.setAttribute("aria-label", "Lock in available. " + TIP_WORDS(stem));
    pill.tabIndex = 0;
    pill.innerHTML = pillHtml(stem);
    stopRow(pill);
    pill.addEventListener("click", () => (S.tip && S.tip.mark === pill ? hideTip() : showTip(pill, stem)));
    pill.addEventListener("mouseenter", () => showTip(pill, stem));
    pill.addEventListener("mouseleave", hideTip);
    pill.addEventListener("focus", () => showTip(pill, stem));
    pill.addEventListener("blur", hideTip);
    return pill;
  };
  /** Our own hover card under a pill: at once, in the skin; no browser tooltip, no question-mark cursor. */
  const placeTip = () => {
    if (!S.tip) return;
    const r = S.tip.mark.getBoundingClientRect();
    const w = S.tip.el.offsetWidth;
    S.tip.el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + "px";
    S.tip.el.style.top = r.bottom + 7 + "px";
  };
  const showTip = (mark, stem) => {
    hideTip();
    const tip = document.createElement("div");
    tip.className = "ael-ui ael-tip " + SKIN;
    tip.innerHTML = '<b><span class="ael-ic">' + SHIELD_FILL + "</span>Lock in available</b><span>" + esc(TIP_WORDS(stem)) + "</span>";
    document.body.appendChild(tip);
    S.tip = { el: tip, mark, stem };
    placeTip();
  };
  const hideTip = () => {
    if (S.tip) S.tip.el.remove();
    S.tip = null;
  };
  // the card is fixed over the page: it goes when the page scrolls or anything else is pressed
  document.addEventListener("scroll", hideTip, true);
  document.addEventListener("pointerdown", (e) => { if (!(S.tip && S.tip.mark.contains(e.target))) hideTip(); }, true);
  /**
   * One pill per protectable game on the page. Keyed by the game, so a venue that redraws its
   * list gets the same pill back in the same place, and an open hover card moves to the new pill
   * instead of closing.
   */
  const markGames = (nodes) => {
    const found = marksOn() ? findGames(nodes) : new Map();
    const keep = new Set();
    for (const [stem, where] of found) {
      if (!gameOpen(stem).length) continue;
      let P = S.pills.get(stem);
      const spot = P && P.foot && where.card ? { anchor: null, card: where.card } : where.anchor ? where : cardSpot(where.card);
      keep.add(stem);
      const placed = P && P.el.isConnected && ((spot.anchor && P.el.previousSibling === pillAfter(spot)) || (!spot.anchor && P.el.parentNode && P.el.parentNode.parentNode === spot.card));
      if (placed) {
        const html = pillHtml(stem);
        if (P.html !== html) {
          P.el.innerHTML = html;
          P.html = html;
        }
        continue;
      }
      const el = newPill(stem);
      const wasTip = P && S.tip && S.tip.mark === P.el ? P.el.getBoundingClientRect() : null;
      if (P) unmountPill(P.el);
      mountPill(el, spot);
      // a pill the page gives no room to (cut by a line, or in a box of no size) goes on its own
      // line at the foot of the card instead; remembered, so the next scan puts it there at once
      let foot = Boolean(P && P.foot);
      if (where.card && !foot && !shows(el)) {
        unmountPill(el);
        foot = true;
        mountPill(el, { anchor: null, card: where.card });
      }
      S.pills.set(stem, { el, html: el.innerHTML, foot });
      // a redraw in place keeps the open card, on the new pill; a pill that moved elsewhere loses it
      if (wasTip) {
        const r = el.getBoundingClientRect();
        if (Math.abs(r.top - wasTip.top) < 40 && Math.abs(r.left - wasTip.left) < 120) S.tip.mark = el;
        else hideTip();
      }
    }
    for (const [stem, P] of S.pills) {
      if (keep.has(stem)) continue;
      if (S.tip && S.tip.mark === P.el) hideTip();
      unmountPill(P.el);
      S.pills.delete(stem);
    }
    // a venue that copies its markup wholesale copies our pills with it: only the ones we hold stay
    const ours = new Set([...S.pills.values()].map((P) => P.el));
    for (const el of document.querySelectorAll(".ael-pill")) if (!ours.has(el)) unmountPill(el);
    if (S.tip) {
      if (!S.tip.mark.isConnected) hideTip();
      else placeTip();
    }
    S.counts.games = found.size;
    S.counts.marks = S.pills.size;
  };

  /**
   * The slip: the block with the venue's place-order button, climbing from a text node that names
   * a club. Its pick is the club named most in it; a Spread or Total pick gets nothing, protection
   * covers the Winner market. No stake is read.
   */
  const PLACE_RE = /\b(place|submit|confirm|review|buy|sell|add to|trade)\b/i;
  const slipFrom = (node) => {
    let e = node.parentElement;
    for (let i = 0; e && e !== document.body && i < 10; i++, e = e.parentElement) {
      const r = e.getBoundingClientRect();
      if (r.width > 720 || r.height > 1400) return null;
      if ((e.textContent || "").length > 900) return null;
      const btn = [...e.querySelectorAll("button, [role=button], input[type=submit]")].find((b) => !OURS(b) && PLACE_RE.test(norm(b.textContent || b.value || "")));
      if (btn) return e;
    }
    return null;
  };
  const findSlip = (nodes) => {
    for (const node of nodes) {
      if (OURS(node)) continue;
      // a line naming a club, even one the line alone cannot settle ("DAL @ PHI" when Dallas
      // plays twice in the window): the slip's whole text, with its date, settles it below
      const sides = sidesIn(node.nodeValue);
      if (!sides.size && !sides.ambiguous) continue;
      const block = slipFrom(node);
      if (!block) continue;
      const text = spaced(norm(wordsOf(block, 2000)));
      if (pointsRow(text)) return null;
      const games = gamesIn(text);
      // the same two clubs twice in the window: the slip's date or weekday says which game, else nothing
      const game = settleStems(games, text);
      if (games.length > 1 && !game) return null;
      // the pick is a club with no listed game (its game this week has started; its next is not
      // listed yet): nothing, never its opponent's next game
      if (unlistedPick(text)) return null;
      const count = sidesIn(text);
      if (!count.size) return null;
      const sorted = [...count.entries()].sort((a, b) => b[1] - a[1]).filter(([t]) => !game || stemOf(t) === game);
      if (!sorted.length) return null;
      let ticker = sorted.length === 1 || sorted[0][1] > sorted[1][1] ? sorted[0][0] : null;
      // a slip that names both clubs once each ("DEN at ARI"): the game is enough for the pill
      if (!ticker && game) ticker = gameOpen(game)[0] ? gameOpen(game)[0].ticker : sorted[0][0];
      if (!ticker) return null;
      let flipped = false;
      if (VENUE_ID === "kalshi" && sideWord(text) === "no") {
        const other = siblingOf(ticker);
        if (other) {
          ticker = other;
          flipped = true;
        }
      }
      const kind = kindIn(text);
      return { block, ticker, stem: stemOf(ticker), kind, flipped };
    }
    return null;
  };
  const paintSlip = (B) => {
    if (!B.host || !B.host.isConnected) {
      B.host && B.host.remove();
      const host = document.createElement("div");
      host.className = "ael-ui ael-slip " + SKIN;
      stopRow(host);
      // just above the place button: before the block's own child that holds it
      const btn = [...B.block.querySelectorAll("button")].filter((b) => !OURS(b) && PLACE_RE.test(norm(b.textContent || ""))).pop();
      let row = btn;
      while (row && row.parentElement && row.parentElement !== B.block) row = row.parentElement;
      if (row && row.parentElement === B.block) B.block.insertBefore(host, row);
      else B.block.appendChild(host);
      B.host = host;
      B.html = null;
    }
    const when = VENUE_ID === "kalshi" ? "after this fills" : "after this is matched";
    const u = gameUntil(B.stem);
    const html = '<span class="ael-ic">' + SHIELD_FILL + "</span><span><b>Lock in available</b> " + when + (u ? " &middot; " + esc(untilWords(u)) : "") + " &middot; from " + esc(V.page) + (B.flipped ? " &middot; your No is a pick on the " + esc(shortOf(B.ticker)) : "") + "</span>";
    if (B.html !== html) {
      B.host.innerHTML = html;
      B.html = html;
    }
  };
  const scanSlip = (nodes) => {
    const F = slipOn() ? findSlip(nodes) : null;
    S.counts.slip = F ? 1 : 0;
    const show = F && F.kind === "winner" && gameOpen(F.stem).length > 0;
    S.counts.slipMarked = show ? 1 : 0;
    if (!show) {
      if (S.slip) S.slip.host && S.slip.host.remove();
      S.slip = null;
      return;
    }
    let B = S.slip;
    if (B && (B.stem !== F.stem || B.block !== F.block)) {
      B.host && B.host.remove();
      B = null;
    }
    if (!B) B = { ...F, host: null, html: null };
    else {
      B.ticker = F.ticker;
      B.flipped = F.flipped;
    }
    S.slip = B;
    paintSlip(B);
  };

  // ── telemetry: anonymous counts, once per page view, so a live venue can be read without a screenshot
  const EXT_VERSION = (() => {
    try {
      return chrome.runtime.getManifest().version;
    } catch {
      return "0.0.0";
    }
  })();
  const teleVenue = () => (/^(127\.0\.0\.1|localhost)$/.test(location.hostname) ? "preview" : VENUE_ID);
  const sendTelemetry = () => {
    if (S.settings.telemetry === "no" || S.serviceState !== "ok" || S.ext.legacy) return;
    const page = S.pageOk ? "plays" : S.counts.games > 1 ? "board" : S.counts.games === 1 || S.counts.slip ? "game" : "other";
    const counts = { markets: S.markets.length, protectable: S.markets.filter(marketOpen).length, games: S.counts.games, marks: S.counts.marks, slip: S.counts.slip, slipMarked: S.counts.slipMarked, rows: S.counts.rows, offers: S.counts.offers, unread: S.counts.unread };
    void api("/api/shadow/ext-telemetry", "POST", { venue: teleVenue(), page, version: EXT_VERSION, counts });
  };
  const teleTick = () => {
    const key = location.pathname + location.hash;
    if (S.tele.key !== key) {
      S.tele.key = key;
      clearTimeout(S.tele.timer);
      // the page's own loading first, then one post for the view
      S.tele.timer = setTimeout(sendTelemetry, 6_000);
    }
  };
  /** Semantic compare, "0.7.0" against "0.10.1": negative when a is older. */
  const cmpVersion = (a, b) => {
    const A = String(a).split(".").map(Number);
    const B = String(b).split(".").map(Number);
    for (let i = 0; i < Math.max(A.length, B.length); i++) {
      const d = (A[i] || 0) - (B[i] || 0);
      if (d) return d;
    }
    return 0;
  };

  // ── the fallback card: the service knows the positions but no row on the page was read ──
  const ensureCard = () => {
    let c = document.getElementById("ael-card");
    if (c) return c;
    c = document.createElement("div");
    c.id = "ael-card";
    c.className = "ael-ui ael-card " + SKIN;
    c.innerHTML = '<div class="ael-card-h"><span>Your ' + esc(V.plays) + ' &middot; protection</span><button type="button" class="ael-x" aria-label="Hide">&times;</button></div><div class="ael-card-b"></div>';
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
        const st = stateOf(B);
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
      n.className = "ael-ui ael-note " + SKIN;
      document.body.appendChild(n);
    }
    n.style.display = "";
    n.innerHTML = '<span class="ael-ic">' + SHIELD + "</span>" + esc(text);
  };

  // ── the scan ────────────────────────────────────────────────────────────────
  let scanTimer = null;
  /**
   * One play, one block. A page that names the same pick in two places (a card and a copy of it
   * mid-redraw, a list and its detail) is quoted once: the quote is kept per market, so two rows
   * sized differently would take turns at it and the offer would swing between their figures.
   * The row whose size the venue confirmed is kept, else the one read from the page, else the first.
   */
  const rowRank = (F) => (F.match === "settled" ? 0 : F.from === "service" ? 3 : F.from === "page" ? 2 : 1);
  const onePerPlay = (found) => {
    const best = new Map();
    for (const F of found) {
      const k = F.ticker + "#" + F.kind;
      const cur = best.get(k);
      if (!cur || rowRank(F) > rowRank(cur)) best.set(k, F);
    }
    const keep = new Set(best.values());
    return found.filter((F) => keep.has(F));
  };
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
    if (S.serviceState === "old") {
      // too old for the service: nothing is drawn but the notice, on every page
      for (const [, B] of S.rows) B.host && B.host.remove();
      S.rows.clear();
      paintCard(false);
      markGames([]);
      scanSlip([]);
      paintNotice("Lock in: update the extension. This build (" + EXT_VERSION + ") is below the service's minimum (" + S.ext.minVersion + ").");
      return;
    }
    if (!S.pageOk) {
      for (const [, B] of S.rows) B.host && B.host.remove();
      S.rows.clear();
      paintCard(false);
      paintNotice("");
      // before the trade: the pill on each protectable game's card, and in the slip
      const nodes = textNodes();
      markGames(nodes);
      const slipWas = S.slip && S.slip.block;
      scanSlip(nodes);
      // a slip just found or gone: the game pills keep out of it
      if ((S.slip && S.slip.block) !== slipWas) markGames(nodes);
      S.counts.rows = S.counts.offers = S.counts.unread = 0;
      teleTick();
      return;
    }
    markGames([]);
    scanSlip([]);
    paintNotice(
      S.serviceState === "key"
        ? "Lock in: the lock key is missing or wrong. Open the extension's settings."
        : S.serviceState === "off"
          ? "Lock in: the service has no lock routes configured."
          : S.serviceState === "gone"
            ? "Lock in was updated. Reload this page."
            : S.serviceState === "down"
              ? (S.marketsTries || 0) <= RETRY_MS.length
                ? "Lock in: waking the service\u2026"
                : "Lock in: the service is unreachable" + (S.downDetail ? " (" + S.downDetail + ")." : ".")
              : "",
    );
    const nodes = textNodes();
    S.tab = tabState(nodes);
    const found = onePerPlay(findRows(nodes));
    const live = new Set();
    // a venue that redraws its list hands us new row elements for the same plays; the block we
    // already built for a play moves under its new row as it is, rather than being built again
    const orphans = [...S.rows.values()].filter((B) => !B.row.isConnected);
    for (const F of found) {
      // a settled play that was never locked here is the venue's own business: no line under it
      if (F.match === "settled" && !lockHere(F.ticker)) {
        const old = S.rows.get(F.row);
        if (old) {
          old.host && old.host.remove();
          S.rows.delete(F.row);
        }
        continue;
      }
      live.add(F.row);
      let B = S.rows.get(F.row);
      if (B && B.ticker !== F.ticker) {
        B.host.remove();
        B = null;
      }
      if (!B) {
        const i = orphans.findIndex((o) => o.ticker === F.ticker && o.kind === F.kind);
        if (i >= 0) {
          B = orphans.splice(i, 1)[0];
          S.rows.delete(B.row);
          B.row = F.row;
          S.rows.set(F.row, B);
          remountHost(B);
        }
      }
      if (!B) {
        B = { ...F, host: null, box: null };
        S.rows.set(F.row, B);
        mountHost(B);
      } else {
        // a size the holder typed survives a page that still cannot be read; anything read wins.
        // A size the venue confirmed (through the service) is not replaced by a reading of the
        // page's words on a later pass: the page redraws, the position does not
        if ((F.from !== "none" || B.from !== "entered") && !(B.from === "service" && F.from !== "service" && svcHeld(B.ticker))) {
          B.size = F.size;
          B.from = F.from;
        }
        B.kind = F.kind;
        B.match = F.match;
        B.flipped = F.flipped;
        if (!B.host.isConnected) remountHost(B);
      }
      B.missedAt = 0;
      quoteRow(B);
      paintRow(B);
    }
    for (const [row, B] of S.rows) {
      if (row.isConnected && live.has(row)) continue;
      // a row still on the page that one pass could not read (the venue mid-redraw, a figure
      // momentarily blank) keeps its block for a few seconds rather than blinking out and back;
      // a row that left the page, or that no longer names the play, lets go at once
      const named = row.isConnected && B.host && B.host.isConnected ? sidesIn(spaced(norm(pageText(row)))) : null;
      if (named && (named.has(B.ticker) || (B.flipped && named.has(siblingOf(B.ticker))))) {
        if (!B.missedAt) {
          B.missedAt = now;
          continue;
        }
        if (now - B.missedAt < ROW_GRACE_MS) continue;
      }
      B.host && B.host.remove();
      S.rows.delete(row);
    }
    paintCard(found.length === 0 && S.svc.configured && S.svc.positions.length > 0);
    S.counts.rows = S.rows.size;
    S.counts.offers = [...S.rows.values()].filter((B) => { const st = S.st.get(B.ticker); return st && st.quote && st.quote.ok; }).length;
    S.counts.unread = [...S.rows.values()].filter((B) => B.from === "none").length;
    teleTick();
  };

  // ── start ───────────────────────────────────────────────────────────────────
  let raf = null;
  const observer = new MutationObserver((muts) => {
    if (raf) return;
    if (muts.every((m) => OURS(m.target))) return;
    // a redraw that pulled one of our blocks out of the page is put right before it is painted
    for (const [row, B] of S.rows) {
      if (!row.isConnected || (B.host && !B.host.isConnected)) {
        scan(true);
        return;
      }
    }
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
    // the holder typing on the page (a filter, a search) may redraw the list; our own fields do not
    document.addEventListener("input", (e) => !OURS(e.target) && scan(false), true);
    window.addEventListener("hashchange", () => (hideTip(), scan(true)));
    window.addEventListener("popstate", () => (hideTip(), scan(true)));
  };

  if (document.readyState === "complete" || document.readyState === "interactive") start();
  else document.addEventListener("DOMContentLoaded", start);
  // inert inside the extension (isolated world); lets a page-level harness read state when it injects this file
  if (window.__AEL_DEBUG) {
    window.__ael = S;
    window.__aelFns = { sidesIn, rowFrom, findRows, textNodes, tableSize, sizeIn, tabState, centsSize, sideWord, siblingOf, findSlip, findGames, gamesIn, markGames, indexMarkets, kindIn, loadPositions, scan, plausible, venue: VENUE_ID };
  }
})();
