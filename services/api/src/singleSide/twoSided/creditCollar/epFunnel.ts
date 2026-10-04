/**
 * EARN & PROTECT FUNNEL — top-of-funnel visibility, privacy-clean. The wallet registry only counts
 * wallets that successfully WRAPPED; this module counts wallets that LOOKED (viewed positions or
 * state) and simple daily page loads, so the operator can tell a reach problem ("nobody clicked")
 * from a conversion problem ("they looked and hesitated"). No IPs, no fingerprints, no third-party
 * analytics — just addresses the visitor already typed in, and counters.
 *
 * Pure module: the service owns persistence (EpStores) and flush cadence.
 */

export type LookerRow = { firstMs: number; lastMs: number; views: number };

export type FunnelState = {
  /** account (lowercase) → look history. Bounded by distinct visitors — tiny at any realistic scale. */
  lookers: Record<string, LookerRow>;
  /** UTC day "YYYY-MM-DD" → page → loads. Pruned beyond `PAGELOAD_RETENTION_DAYS`. */
  pageLoads: Record<string, Record<string, number>>;
};

export const emptyFunnel = (): FunnelState => ({ lookers: {}, pageLoads: {} });

export const dayKey = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const PAGELOAD_RETENTION_DAYS = 30;
const DAY_MS = 86_400_000;

/** Record an address viewing its positions/state. Mutates; returns true when state changed. */
export const recordLooker = (f: FunnelState, account: string, nowMs: number): boolean => {
  const key = account.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(key)) return false;
  const row = f.lookers[key];
  if (row) {
    row.lastMs = nowMs;
    row.views += 1;
  } else {
    f.lookers[key] = { firstMs: nowMs, lastMs: nowMs, views: 1 };
  }
  return true;
};

/**
 * Everything the funnel counts per UTC day. Page loads (app/miniapp/public/video), a no-address
 * preview quote, a watch-mode view, and the OUTBOUND CLICKS: the site's own /record, /prediction
 * and /prediction/record redirect to sister services, so a click is counted here before it leaves.
 */
export const FUNNEL_PAGES = ["app", "miniapp", "public", "preview", "watch", "video", "record", "prediction", "prediction_record"] as const;
export type FunnelPage = (typeof FUNNEL_PAGES)[number];

/** Column labels on the traffic page: short, so all nine fit one row on a laptop. */
export const FUNNEL_PAGE_LABELS: Record<FunnelPage, string> = {
  app: "app",
  miniapp: "Telegram app",
  public: "public",
  preview: "previews",
  watch: "showcase",
  video: "video",
  record: "to perp record",
  prediction: "to prediction markets",
  prediction_record: "to prediction record"
};

/** Record a page load, a no-address preview quote, a watch-mode view, or an outbound click. Mutates; prunes days beyond retention. */
export const recordPageLoad = (f: FunnelState, page: FunnelPage, nowMs: number): void => {
  const day = dayKey(nowMs);
  const bucket = (f.pageLoads[day] ??= {});
  bucket[page] = (bucket[page] ?? 0) + 1;
  const cutoff = dayKey(nowMs - PAGELOAD_RETENTION_DAYS * DAY_MS);
  for (const d of Object.keys(f.pageLoads)) if (d < cutoff) delete f.pageLoads[d];
};

export type FunnelSummary = {
  /** Headline counts EXCLUDE internal accounts (the operator's own test wallets). */
  distinctLookers: number;
  lookers24h: number;
  lookers7d: number;
  /** The conversion gap: looked at positions but never wrapped (external only). */
  lookedNeverWrapped: number;
  /** How many of the recorded lookers are the operator's own accounts. */
  internalLookers: number;
  /** Most recent lookers (≤20), newest first — internal rows flagged, not hidden. */
  recentLookers: Array<{ account: string; views: number; firstMs: number; lastMs: number; wrapped: boolean; internal: boolean }>;
  /** Last 7 UTC days of page loads, oldest first, with per-page counts. Page loads happen before
   *  an address is typed, so they CANNOT be attributed to a wallet — internal visits included. */
  pageLoads7d: Array<{ day: string; total: number; byPage: Record<string, number> }>;
};

/** Parse EP_INTERNAL_ACCOUNTS (comma-separated addresses) — the operator's own test wallets. */
export const parseInternalAccounts = (raw: string | undefined): Set<string> =>
  new Set(
    (raw ?? "")
      .split(",")
      .map((a) => a.trim().toLowerCase())
      .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
  );

export const funnelSummary = (f: FunnelState, wrappedAccounts: Set<string>, nowMs: number, internalAccounts: Set<string> = new Set()): FunnelSummary => {
  const rows = Object.entries(f.lookers);
  const wrapped = new Set([...wrappedAccounts].map((a) => a.toLowerCase()));
  const internal = new Set([...internalAccounts].map((a) => a.toLowerCase()));
  const external = rows.filter(([a]) => !internal.has(a));
  const within = (row: LookerRow, ms: number) => nowMs - row.lastMs <= ms;
  const recent = rows
    .sort((a, b) => b[1].lastMs - a[1].lastMs)
    .slice(0, 20)
    .map(([account, r]) => ({ account, views: r.views, firstMs: r.firstMs, lastMs: r.lastMs, wrapped: wrapped.has(account), internal: internal.has(account) }));
  const days: Array<{ day: string; total: number; byPage: Record<string, number> }> = [];
  for (let i = 6; i >= 0; i--) {
    const day = dayKey(nowMs - i * DAY_MS);
    const byPage = f.pageLoads[day] ?? {};
    days.push({ day, total: Object.values(byPage).reduce((s, n) => s + n, 0), byPage });
  }
  return {
    distinctLookers: external.length,
    lookers24h: external.filter(([, r]) => within(r, DAY_MS)).length,
    lookers7d: external.filter(([, r]) => within(r, 7 * DAY_MS)).length,
    lookedNeverWrapped: external.filter(([a]) => !wrapped.has(a)).length,
    internalLookers: rows.length - external.length,
    recentLookers: recent,
    pageLoads7d: days
  };
};

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * The operator's traffic page for the perp site (GET /admin/funnel, EP_ADMIN_TOKEN). The same
 * shape as the event demo's funnel page so both read alike: who looked, where they came in, and
 * how many left for the sister surfaces. Server-rendered, no client JS, nothing personal beyond
 * the addresses visitors typed in themselves.
 */
export const renderEpFunnelHtml = (
  s: FunnelSummary,
  meta: { atIso: string; links: Array<{ label: string; url: string; alive: boolean }> }
): string => {
  const dayLabel = (day: string): string => {
    const d = new Date(`${day}T00:00:00Z`);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${day.slice(5)}`;
  };
  const utc = (ms: number): string => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const kv = (rows: Array<[string, string | number]>): string =>
    rows.map(([k, v]) => `<div class="row"><span>${escapeHtml(k)}</span><b>${escapeHtml(String(v))}</b></div>`).join("");
  const sum = (page: FunnelPage): number => s.pageLoads7d.reduce((n, d) => n + (d.byPage[page] ?? 0), 0);
  const visits7d = sum("app") + sum("miniapp") + sum("video");
  const outbound7d = sum("record") + sum("prediction") + sum("prediction_record");
  const head = FUNNEL_PAGES.map((p) => `<th>${escapeHtml(FUNNEL_PAGE_LABELS[p])}</th>`).join("");
  const days = s.pageLoads7d
    .map((d) => `<tr><td>${escapeHtml(dayLabel(d.day))}</td>${FUNNEL_PAGES.map((p) => `<td${p === "prediction" ? ' class="hi"' : ""}>${d.byPage[p] ?? 0}</td>`).join("")}</tr>`)
    .join("");
  const totals = `<tr class="total"><td>7-day total</td>${FUNNEL_PAGES.map((p) => `<td>${sum(p)}</td>`).join("")}</tr>`;
  const recent = s.recentLookers
    .map(
      (r) =>
        `<tr><td>${escapeHtml(utc(r.lastMs))}</td><td class="mono">${escapeHtml(short(r.account))}</td><td>${r.views}</td><td>${r.wrapped ? "yes" : "no"}</td><td>${r.internal ? "internal" : ""}</td></tr>`
    )
    .join("");
  const links = meta.links
    .map(
      (l) =>
        `<div class="row"><span>${escapeHtml(l.label)}</span><b>${l.url ? `<em class="${l.alive ? "up" : "down"}">${l.alive ? "up, link shown" : "down, link hidden"}</em> ${escapeHtml(l.url)}` : "off"}</b></div>`
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>Funnel · Earn &amp; Protect · perps</title>
<style>
:root{--bg:#f6f7f7;--card:#fff;--card2:#f2f4f4;--line:#e4e7e7;--ink:#050d0a;--dim:#5c6a64;--faint:#98a49e;--green:#00b67a;--warn:#b9862f}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#050d0a}
.topbar .in{max-width:980px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:10px 16px}
.topbar .wordmark{color:#fff;font-weight:650;font-size:14px}
.topbar .wordmark span{color:#8f9c96;font-weight:400}
.wrap{max-width:980px;margin:0 auto;padding:14px 14px 40px}
.grid{display:grid;grid-template-columns:1fr;gap:12px}
@media(min-width:700px){.grid.two{grid-template-columns:1fr 1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin-bottom:12px;box-shadow:0 1px 2px rgba(5,13,10,.04)}
.grid .card{margin-bottom:0}
h1{font-size:19px;font-weight:650;letter-spacing:-.01em}
.sub{color:var(--dim);font-size:13px;margin-top:4px}
.bignums{display:flex;gap:10px;margin-top:14px;flex-wrap:wrap}
.bignum{flex:1;min-width:120px;background:var(--card2);border-radius:10px;padding:12px;text-align:center}
.bignum .n{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
h2{font-size:12px;color:var(--dim);font-weight:600;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.row{display:flex;justify-content:space-between;gap:12px;padding:6px 0;font-size:13.5px;color:var(--dim);font-variant-numeric:tabular-nums;border-top:1px solid var(--line)}
.row:first-of-type{border-top:0}
.row b{color:var(--ink);font-weight:650;text-align:right;overflow-wrap:anywhere;font-size:12.5px}
.row b em{font-style:normal;font-weight:650;white-space:nowrap}
.row b em.up{color:var(--green)} .row b em.down{color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--dim);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;padding:6px 5px;border-bottom:1px solid var(--line);vertical-align:bottom;line-height:1.25}
td{padding:7px 5px;border-bottom:1px solid var(--line);color:var(--dim);white-space:nowrap}
td.hi{color:var(--ink);font-weight:650}
td.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;color:var(--ink)}
tr.total td{color:var(--ink);font-weight:650;border-bottom:0}
.tablewrap{overflow-x:auto}
.empty{color:var(--faint);font-size:13px;padding:8px 0}
footer{color:var(--faint);font-size:11.5px;line-height:1.55;padding:14px 4px 0}
</style>
</head>
<body>
<div class="topbar"><div class="in"><div class="wordmark">Earn &amp; Protect <span>· funnel · perps</span></div></div></div>
<div class="wrap">
  <div class="card">
    <h1>Who came, who looked, who left for the sister surfaces</h1>
    <div class="sub">Page loads are anonymous counters. Lookers are the addresses visitors typed in themselves; no IPs, no fingerprints. Updated ${escapeHtml(meta.atIso.slice(0, 16).replace("T", " "))} UTC.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${visits7d}</div><div class="l">page loads, 7 days</div></div>
      <div class="bignum"><div class="n">${s.lookers7d}</div><div class="l">lookers, 7 days</div></div>
      <div class="bignum"><div class="n green">${sum("prediction")}</div><div class="l">clicks to prediction markets, 7 days</div></div>
      <div class="bignum"><div class="n">${outbound7d}</div><div class="l">all outbound clicks, 7 days</div></div>
    </div>
  </div>
  <div class="grid two">
    <div class="card">
      <h2>Lookers</h2>
      ${kv([
        ["distinct, all time", s.distinctLookers],
        ["active in the last 24h", s.lookers24h],
        ["active in the last 7 days", s.lookers7d],
        ["looked but never wrapped", s.lookedNeverWrapped],
        ["operator accounts (excluded above)", s.internalLookers]
      ])}
    </div>
    <div class="card">
      <h2>Cross-links (fail closed)</h2>
      ${links || '<div class="empty">no outbound links configured</div>'}
    </div>
  </div>
  <div class="card" style="margin-top:12px">
    <h2>Last 7 days, UTC</h2>
    <div class="tablewrap"><table>
      <thead><tr><th>day</th>${head}</tr></thead>
      <tbody>${days}${totals}</tbody>
    </table></div>
  </div>
  <div class="card">
    <h2>Recent lookers</h2>
    ${recent ? `<div class="tablewrap"><table><thead><tr><th>last seen</th><th>address</th><th>views</th><th>wrapped</th><th></th></tr></thead><tbody>${recent}</tbody></table></div>` : '<div class="empty">no addresses looked up yet</div>'}
  </div>
  <footer>Outbound clicks are counted by the site's own /record, /prediction and /prediction/record redirects, so they are exact for links on this site and zero for visitors who typed a sister URL directly. The JSON is at /api/admin/status (funnel).</footer>
</div>
</body>
</html>`;
};
