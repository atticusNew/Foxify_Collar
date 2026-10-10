/**
 * EMBED DEMO — the protection layer inside somebody else's app.
 *
 * The pitch to a prediction market or broker is not "send your users to our
 * page"; it is "one button on your positions list". This page is that pitch,
 * runnable: a host shell (a brand's positions list, their colours, their
 * wordmark) with our Protect button on every row. Tapping it opens the Protect
 * sheet, priced live from the same scan as the public board; one more tap and
 * the row reshapes to what protection really is on a binary contract: the
 * position now ends at a floor or a cap, and part of it was paid today.
 * Nothing leaves the host.
 *
 * Copy is outcomes, not mechanics: a row reads "ends $0 or $150" before and
 * "ends $79.66 or $91.66 · $3.81 paid now" after. Contracts kept, cash set
 * aside and the collar identity stay in the code comment below and in "how it
 * works", never on the row.
 *
 * Positions are the board's simulated positions (real prints, live marks); the
 * sheet reads /api/showcase?ticker= (retail shape, so dev tools show a visitor
 * exactly what the sheet shows). Taps are counted in the same funnel as the
 * public board under page "embed".
 *
 * The Parlays tab lists the shadow's simulated tickets (/api/parlays, a
 * read-through of the record's public /api/shadow/parlays). A row has three
 * states: two or more picks open and the lock is not offered yet; one pick
 * open and the lock reads "Lock in $floor · $credit paid now", or the reason
 * it was refused (one clause on the row, the full reason a tap away); settled
 * or busted and the ticket sits as one line under a collapsed Settled group,
 * the lock-against-ticket comparison on tap. The honesty note is one line
 * with the long version behind an info button. The lock's terms are the
 * shadow's, priced from the live book at the moment; the browser re-prices
 * nothing.
 *
 * `?brand=` names the host; it is honoured only when the name is on
 * EVENT_X_BRAND_ALLOWLIST (fail-closed to EVENT_X_EMBED_BRAND, else "Your
 * app"), so nobody can render a competitor's or a regulator's name into a
 * screenshot. A recognised brand also brings its colourway and its default
 * shell (light or dark); `?skin=` overrides. The sheet keeps its own look in
 * every host, because that is the point: the sheet is ours, the shell is theirs.
 */

import { ATTICUS_WORDMARK_GOLD_DATA_URI } from "./eventProtectLogo";
import type { CrossLedgerSummary } from "../src/eventCollar/crossVenue/crossLedger";
import type { EventFunnelSummary } from "../src/eventCollar/crossVenue/eventFunnel";
import { DEFAULT_MINIMUM_CREDIT, type MinimumCreditRule } from "../src/eventCollar/crossVenue/minimumCredit";
import { slateLinkKey, slateSlugOf } from "../src/eventCollar/crossVenue/venueSlate";

export interface EmbedOptions {
  /** the host's display name, already checked against the allowlist */
  brand: string;
  /** the shell; when absent the brand preset decides */
  skin?: "light" | "dark" | null;
  /** games only (true), the whole board (false); when absent the brand preset decides */
  sportsOnly?: boolean | null;
  /** the server's minimum-credit rule, mirrored in the page script so a stale client never shows a tier the server dropped */
  minCredit?: MinimumCreditRule;
  /** the track record's URL: the phone's one link, and the first partner link on desktop */
  trackRecordUrl?: string;
  /**
   * The record link is the brand's own slate page: label it so, and keep the
   * whole-book pages (receipts, full board) off this shell, since they have no
   * per-brand cut and would read as "the full version" beside the brand's slate.
   */
  recordIsSlate?: boolean;
}

const DEFAULT_TRACK_RECORD_URL = "https://atticus-event-shadow.onrender.com";

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The placeholder host: what the shell says when no partner brand is on the link. */
export const DEFAULT_EMBED_BRAND = "Your Exchange";

/** The pip's letter: a real brand's first letter; the placeholder's noun ("Your Exchange" -> E). */
export function brandInitial(brand: string): string {
  const words = brand.trim().split(/\s+/).filter(Boolean);
  const word = words.length > 1 && /^your$/i.test(words[0]) ? words[1] : words[0];
  return (word?.[0] ?? "A").toUpperCase();
}

/**
 * Resolve `?brand=` against the allowlist; anything else is the default brand (EVENT_X_EMBED_BRAND,
 * else "Your Exchange"). The default is what the first screen says when a visitor arrives with no link.
 */
export function resolveBrand(requested: string | null | undefined, allowlist: string | undefined, fallback = DEFAULT_EMBED_BRAND): string {
  const dflt = (fallback ?? "").trim() || DEFAULT_EMBED_BRAND;
  const want = (requested ?? "").trim();
  if (!want) return dflt;
  const allowed = (allowlist ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = allowed.find((a) => a.toLowerCase() === want.toLowerCase());
  return hit ?? dflt;
}

/** A host's colourway: one accent (tab underline, brand pip), the ink on it, and the shell it ships. */
export interface BrandTheme {
  accent: string;
  accentInk: string;
  skin: "light" | "dark";
  /**
   * The host lists games and nothing else, so the shell hides the crypto strikes the board also
   * carries: a Bitcoin row inside a sportsbook's positions list is not their app. `?kind=all`
   * on the link overrides for a demo of the whole board.
   */
  sportsOnly?: boolean;
}

/** The generic host: a neutral slate that belongs to no brand, on a light shell. */
export const GENERIC_THEME: BrandTheme = { accent: "#3D4F73", accentInk: "#ffffff", skin: "light" };

/**
 * Basic, recognisable colourways for the hosts a partner would expect to see. Just enough for the
 * screenshot to read as their app: their primary colour and whether they ship light or dark. Keys
 * are the brand name lower-cased with spaces removed; anything else gets GENERIC_THEME.
 */
export const BRAND_PRESETS: Readonly<Record<string, BrandTheme>> = {
  kalshi: { accent: "#0EA870", accentInk: "#ffffff", skin: "light" },
  polymarket: { accent: "#2D6BFF", accentInk: "#ffffff", skin: "dark" },
  prophetx: { accent: "#52CEA6", accentInk: "#11162C", skin: "dark", sportsOnly: true },
  novig: { accent: "#C6FF3D", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  sporttrade: { accent: "#22C55E", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  draftkings: { accent: "#53D337", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  fanduel: { accent: "#1493FF", accentInk: "#ffffff", skin: "dark", sportsOnly: true },
  prizepicks: { accent: "#8000FF", accentInk: "#ffffff", skin: "dark", sportsOnly: true },
  underdog: { accent: "#F5C400", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  // WagerWire (US bet marketplace) and Wire Markets (its international prediction market): the
  // same charcoal shell and mint accent as wagerwire.com; both list games only.
  wagerwire: { accent: "#02FDDD", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  wiremarkets: { accent: "#02FDDD", accentInk: "#0f1115", skin: "dark", sportsOnly: true },
  robinhood: { accent: "#00C805", accentInk: "#0f1115", skin: "light" },
  coinbase: { accent: "#0052FF", accentInk: "#ffffff", skin: "light" },
  kraken: { accent: "#7132F5", accentInk: "#ffffff", skin: "dark" },
  "crypto.com": { accent: "#1199FA", accentInk: "#ffffff", skin: "dark" },
};

export function brandTheme(brand: string): BrandTheme {
  const key = brand.toLowerCase().replace(/\s+/g, "");
  return BRAND_PRESETS[key] ?? GENERIC_THEME;
}

/**
 * Where a shell's "Track record" goes. A partner brand with the shadow's share key configured
 * (EVENT_SHADOW_SLATE_KEY, the same value on both services) links to its own slate page, carrying
 * the slate's derived link key, so the Wire Markets shell opens the Wire Markets record and
 * nothing else. The placeholder host, or no key, links to the public record.
 */
export function brandRecordUrl(trackRecordUrl: string, brand: string, slateKey: string | undefined, defaultBrand = DEFAULT_EMBED_BRAND): { url: string; slate: boolean } {
  const base = (trackRecordUrl || DEFAULT_TRACK_RECORD_URL).replace(/\/+$/, "");
  const slug = slateSlugOf(brand);
  const link = slateLinkKey(slateKey, slug);
  if (!slug || !link || brand.trim().toLowerCase() === defaultBrand.trim().toLowerCase()) return { url: base, slate: false };
  return { url: `${base}/slate/${slug}?k=${link}`, slate: true };
}

/**
 * MINIMUM CREDIT lives server-side (src/eventCollar/crossVenue/minimumCredit.ts) and is applied in
 * the scan, so what reaches this page has already been filtered. The page script re-checks with the
 * same numbers (passed in via `minCredit`) purely as a belt: a cached page can never show a tier the
 * server would not offer.
 */
export const EMBED_MIN_CREDIT = DEFAULT_MINIMUM_CREDIT;
export function worthOffering(creditCents: number, contracts: number, rule: MinimumCreditRule = DEFAULT_MINIMUM_CREDIT): boolean {
  return creditCents >= Math.max(rule.cents, Math.round((contracts * 100 * rule.bpsOfStake) / 10_000));
}

export function renderEventEmbedHtml(opts: EmbedOptions): string {
  const brand = escapeHtml(opts.brand);
  const theme = brandTheme(opts.brand);
  const dark = (opts.skin ?? theme.skin) === "dark";
  const sportsOnly = opts.sportsOnly ?? theme.sportsOnly ?? false;
  const initial = escapeHtml(brandInitial(opts.brand));
  const minCredit = opts.minCredit ?? DEFAULT_MINIMUM_CREDIT;
  const trackRecordUrl = escapeHtml(opts.trackRecordUrl || DEFAULT_TRACK_RECORD_URL);
  const recordLabel = opts.recordIsSlate ? `${brand} record` : "Track record";
  // a partner's shell keeps its brand on the partner pages it links to
  const brandQ = opts.brand.trim().toLowerCase() === DEFAULT_EMBED_BRAND.toLowerCase() ? "" : `?brand=${encodeURIComponent(opts.brand)}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>${brand} · Positions</title>
<meta name="description" content="How Earn &amp; Protect sits inside a prediction market's positions list: one Protect button per row, one sheet, one tap. Demonstration; positions are simulated, prices are live." />
<style>
:root{
  ${
    dark
      ? `--bg:#0f1115; --card:#171a21; --card2:#1d212a; --line:#262b36; --ink:#f3f5f8; --dim:#9aa3b2; --faint:#6b7382; --up:#3ccf91; --down:#ff6b6b; --frame:rgba(255,255,255,.14);`
      : `--bg:#f4f5f7; --card:#ffffff; --card2:#f7f8fa; --line:#e6e8ec; --ink:#0f1115; --dim:#5f6775; --faint:#98a0ad; --up:#1d9a63; --down:#d64545; --frame:rgba(0,0,0,.12);`
  }
  --accent:${theme.accent}; --accent-ink:${theme.accentInk};
  --stage:#eceef2; --stage-ink:#0f1115; --stage-dim:#5f6775;
  --ep-green:#00b67a; --ep-deep:#014737; --ep-ink:#050d0a; --ep-dim:#5c6a64; --ep-faint:#98a49e; --ep-line:#e4e7e7; --ep-card2:#f2f4f4;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.stage{min-height:100vh}
.pitch{display:none}
.phone{max-width:430px;margin:0 auto;min-height:100vh;background:var(--bg);position:relative}
.host-top{padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between}
.host-top .brand{font-weight:700;font-size:17px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.host-top .brand i{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-style:normal;font-size:12px;font-weight:800}
.host-top .bal{font-variant-numeric:tabular-nums;font-size:13px;color:var(--dim)}
.tabs{display:flex;gap:18px;padding:0 16px;border-bottom:1px solid var(--line)}
.tabs span{padding:8px 0 10px;font-size:14px;color:var(--faint);font-weight:600;cursor:pointer;user-select:none}
.tabs span.on{color:var(--ink);border-bottom:2px solid var(--accent);cursor:default}
.list{padding:8px 12px 110px}
.pos{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px 12px 10px;margin:8px 0}
.pos .h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.pos .name{font-weight:650;font-size:15px;line-height:1.25}
.pos .meta{color:var(--faint);font-size:12px;margin-top:2px}
.pos .pl{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.pos .pl b{display:block;font-size:15px}
.pos .pl.up b{color:var(--up)}.pos .pl.down b{color:var(--down)}
.pos .pl i{font-style:normal;color:var(--faint);font-size:12px}
.pos .f{display:flex;justify-content:space-between;align-items:center;margin-top:10px;gap:10px}
.pos .size{color:var(--dim);font-size:13px;font-variant-numeric:tabular-nums}
.pbtn{appearance:none;border:0;border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;background:var(--ep-green);color:#fff;display:inline-flex;align-items:center;gap:6px;box-shadow:0 1px 0 rgba(0,0,0,.06)}
.pbtn:disabled{opacity:.6;cursor:default}
.pbtn svg{width:13px;height:13px}
.pos.protected{border-color:rgba(0,182,122,.45)}
.pos .shield{display:inline-flex;align-items:center;gap:5px;background:rgba(0,182,122,.12);color:var(--ep-green);font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px}
.pos .terms{margin-top:8px;font-size:13px;color:var(--dim);line-height:1.5;font-variant-numeric:tabular-nums}
.pos .terms b{color:var(--ink);font-weight:650}
.pos .lock{margin-top:4px;font-size:11.5px;color:var(--faint);line-height:1.45}
.pos .undo{color:var(--faint);font-size:11.5px;cursor:pointer;background:none;border:0;font:inherit;padding:2px 4px;opacity:.75}
.pos .undo:hover{text-decoration:underline;opacity:1}
.pos .acts{display:inline-flex;align-items:center;gap:8px}
.pos .closeb{appearance:none;cursor:pointer;font:inherit;font-size:12.5px;font-weight:650;color:var(--ink);background:var(--card);border:1px solid var(--line);border-radius:999px;padding:5px 11px}
.pos .closeb:hover{border-color:var(--ep-green);color:var(--ep-green)}
/* ---- parlays: the picks, their marks, and the lock that only exists at the last pick ---- */
.pos.parlay{padding:10px 12px 9px}
.parlay .pl b,.parlay .pl i{display:inline;font-size:14px}
.parlay .pl i{font-size:12px}
.picks{margin-top:7px;display:flex;flex-direction:column;gap:3px}
.pick{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--faint);line-height:1.35}
.pick i{font-style:normal;width:15px;height:15px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:800;flex-shrink:0;background:var(--card2);color:var(--faint);border:1px solid var(--line)}
.pick.hit i{background:rgba(0,182,122,.14);color:var(--ep-green);border-color:transparent}
.pick.miss i{background:rgba(255,107,107,.14);color:var(--down);border-color:transparent}
.pick span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick span b{font-weight:600;color:var(--ink)}
.pick.miss span b{text-decoration:line-through;color:var(--dim)}
.pick em{font-style:normal;color:var(--faint);font-size:11.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.pick.hit em{color:var(--ep-green)}
.pick.miss em{color:var(--down)}
.pbtn.off{background:var(--card2);color:var(--faint);box-shadow:none;cursor:default;border:1px solid var(--line)}
.pbtn.full{flex:1;justify-content:center;padding:9px 13px}
.pos .f.end{justify-content:flex-end}
.pos .shield.grey{background:var(--card2);color:var(--dim)}
.why{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:12.5px;color:var(--dim);text-align:left;cursor:pointer;flex:1;line-height:1.4}
.why:after{content:" \\203A";color:var(--faint)}
.note{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 4px 0;color:var(--faint);font-size:11.5px;line-height:1.4}
.info{appearance:none;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);background:var(--card2);color:var(--dim);font:italic 700 11px Georgia,"Times New Roman",serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;padding:0}
.grp{display:flex;justify-content:space-between;align-items:center;margin:14px 4px 0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.grp button{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:11.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--dim);cursor:pointer}
.pos.mini{padding:9px 12px;cursor:pointer}
.pos.mini .name{font-size:14px}
.pos.mini .meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:30px 16px;color:var(--faint);text-align:center;font-size:14px}
.host-note{position:fixed;left:0;right:0;bottom:0;padding:10px 16px 14px;text-align:center;color:var(--faint);font-size:11.5px;line-height:1.45;background:linear-gradient(to top,var(--bg) 70%,transparent);pointer-events:none}
/* two deliberate lines (the disclaimer, then the link): never a sentence that wraps and strands the link */
.host-note span,.host-note a{display:block}
.host-note a{color:var(--dim);pointer-events:auto;white-space:nowrap;margin-top:2px}
.toast{position:fixed;left:50%;bottom:64px;transform:translate(-50%,8px);background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;white-space:nowrap;z-index:5}
.toast.on{opacity:.96;transform:translate(-50%,0)}
/* ---- the sheet: ours, same in any host ---- */
.scrim{position:fixed;inset:0;background:rgba(5,13,10,.5);opacity:0;pointer-events:none;transition:opacity .18s;z-index:8}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:430px;background:#fff;color:var(--ep-ink);border-radius:18px 18px 0 0;padding:10px 16px calc(16px + env(safe-area-inset-bottom));transform:translateY(105%);transition:transform .22s cubic-bezier(.2,.8,.2,1);box-shadow:0 -12px 40px rgba(0,0,0,.18);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;z-index:9}
.sheet.on{transform:translateY(0)}
.sheet .grab{width:38px;height:4px;border-radius:2px;background:#dfe3e2;margin:0 auto 12px}
.sheet .eyebrow{display:flex;align-items:center;justify-content:space-between;color:var(--ep-faint);font-size:11.5px;letter-spacing:.02em}
.sheet .eyebrow img{height:20px;display:block}
.sheet h2{font-size:19px;font-weight:700;letter-spacing:-.01em;margin-top:8px;color:var(--ep-ink)}
.sheet .who{color:var(--ep-dim);font-size:13.5px;margin-top:2px}
.tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px}
.tile{background:var(--ep-card2);border-radius:12px;padding:10px 10px 9px;text-align:left}
.tile .l{color:var(--ep-dim);font-size:11.5px}
.tile .v{font-weight:700;font-size:17px;margin-top:2px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tile .was{color:var(--ep-faint);font-size:11px;margin-top:2px;font-variant-numeric:tabular-nums}
.tile.k .v{color:var(--ep-green)}
.chips{display:none;gap:6px;margin-top:12px}
.chips.on{display:flex}
.chip{flex:1;appearance:none;border:1px solid var(--ep-line);background:#fff;border-radius:10px;padding:7px 6px;font:inherit;font-size:12px;color:var(--ep-dim);cursor:pointer;font-variant-numeric:tabular-nums;line-height:1.35}
.chip b{display:block;color:var(--ep-ink);font-size:12.5px}
.chip[aria-pressed="true"]{border-color:var(--ep-green);background:rgba(0,182,122,.07)}
.chip[aria-pressed="true"] b{color:var(--ep-green)}
.go{appearance:none;border:0;width:100%;margin-top:14px;border-radius:12px;padding:14px;background:var(--ep-green);color:#fff;font:inherit;font-weight:700;font-size:16px;cursor:pointer;font-variant-numeric:tabular-nums}
.go:disabled{opacity:.55;cursor:default}
.go.quiet{background:#fff;color:var(--ep-ink);border:1px solid var(--ep-line)}
.sheet .fine{color:var(--ep-faint);font-size:11.5px;text-align:center;margin-top:9px;line-height:1.45}
.sheet .fine a{color:var(--ep-dim)}
.sheet .refusal{background:var(--ep-card2);border-radius:12px;padding:14px;margin-top:14px;color:var(--ep-ink);font-size:14.5px;line-height:1.5}
.sheet .refusal b{font-weight:700}
.sheet .how{display:none;margin-top:12px;color:var(--ep-dim);font-size:13px;line-height:1.55}
.sheet .how.on{display:block}
.sheet .how p{margin:4px 0}
.sheet .done{text-align:center;padding:10px 0 2px}
.sheet .done .ck{width:52px;height:52px;border-radius:50%;background:rgba(0,182,122,.12);color:var(--ep-green);display:inline-flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}
.sheet .done h2{margin-top:10px}
.sheet .done .sum{margin-top:6px;color:var(--ep-dim);font-size:14px;font-variant-numeric:tabular-nums;line-height:1.55}
.sheet .done .sum b{color:var(--ep-ink)}
.skel{height:14px;border-radius:7px;background:var(--ep-card2);margin-top:8px;animation:pulse 1.2s infinite}
@keyframes pulse{0%,100%{opacity:.6}50%{opacity:1}}
/* ---- desktop: the pitch beside a phone; the sheet and scrim stay inside the phone ---- */
@media(min-width:900px){
  body{background:var(--stage);color:var(--stage-ink)}
  .stage{display:grid;grid-template-columns:minmax(300px,420px) 400px;gap:72px;align-items:center;justify-content:center;padding:40px 32px;min-height:100vh}
  .pitch{display:block;color:var(--stage-ink)}
  .pitch img{height:24px;display:block;margin-bottom:22px}
  .pitch h1{font-size:34px;line-height:1.12;letter-spacing:-.02em;font-weight:700}
  .pitch p{color:var(--stage-dim);font-size:16px;line-height:1.55;margin-top:14px;max-width:34em}
  .pitch ul{list-style:none;margin-top:18px;color:var(--stage-ink);font-size:15px;line-height:1.5}
  .pitch li{padding:6px 0 6px 22px;position:relative}
  .pitch li:before{content:"";position:absolute;left:0;top:13px;width:9px;height:9px;border-radius:50%;background:var(--ep-green)}
  .pitch .try{margin-top:22px;color:var(--stage-ink);font-weight:600;font-size:15px}
  .pitch .try b{color:var(--ep-green)}
  .pitch .partners{margin-top:30px;padding-top:16px;border-top:1px solid rgba(15,17,21,.1);color:var(--stage-dim);font-size:12.5px}
  .pitch .partners b{color:var(--stage-ink);font-weight:600;margin-right:8px}
  .pitch .partners a{color:var(--stage-ink);text-decoration:none;border-bottom:1px solid rgba(15,17,21,.25);margin-right:12px}
  .pitch .partners a:hover{border-bottom-color:var(--stage-ink)}
  .pitch .foot{margin-top:14px;color:var(--stage-dim);font-size:12.5px}
  .phone{margin:0;width:400px;height:min(820px,calc(100vh - 80px));min-height:560px;border-radius:40px;border:1px solid var(--frame);box-shadow:0 30px 80px rgba(15,17,21,.22),0 2px 6px rgba(15,17,21,.08);overflow:hidden;display:flex;flex-direction:column;color:var(--ink)}
  .host-top{padding-top:22px}
  .list{flex:1;min-height:0;overflow:auto;padding-bottom:64px}
  .host-note,.scrim,.sheet,.toast{position:absolute}
  .sheet{max-width:none;padding-bottom:22px}
}
</style>
</head>
<body>
<div class="stage">
<aside class="pitch">
  <img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" />
  <h1>Protection inside your app.</h1>
  <p>One button on every open position. Your users lock a floor and get paid today. We price the protection and hedge it leg for leg; you keep the flow, the ledger and the relationship.</p>
  <ul>
    <li>One JSON quote in, one receipt out</li>
    <li>Your brand, your ledger, your official result</li>
    <li>Refuses when the market can't fund a credit</li>
    <li>Parlays: a floor and a credit at the last pick, never before</li>
  </ul>
  <div class="try">Tap <b>Protect</b> on any row, or open <b>Parlays</b> &rarr;</div>
  <div class="partners"><b>For partners</b><a href="${trackRecordUrl}">${recordLabel}</a><a href="/partner${brandQ}">Partner console</a>${opts.recordIsSlate ? "" : '<a href="/receipts">Receipts</a><a href="/board">Full board</a>'}</div>
  <div class="foot">Demonstration only. Simulated positions at live prices; nothing is bought.</div>
</aside>
<div class="phone" id="phone">
  <div class="host-top">
    <div class="brand"><i>${initial}</i>${brand}</div>
    <div class="bal" id="bal">Cash $412.50</div>
  </div>
  <div class="tabs"><span class="on" data-tab="Positions">Positions</span><span data-tab="Parlays">Parlays</span><span data-tab="Markets">Markets</span><span data-tab="Activity">Activity</span></div>
  <div class="list" id="list"><div class="empty" id="loading">loading your positions…</div></div>
  <div class="host-note"><span>Demo. Simulated positions at live prices; nothing is bought.</span><a href="${trackRecordUrl}">${recordLabel}</a></div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <div class="scrim" id="scrim"></div>
  <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="grab"></div>
    <div class="eyebrow"><span>protection by</span><img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" /></div>
    <div id="sh-body"></div>
  </div>
</div>
</div>
<script>
(function(){
  'use strict';
  var S={rows:[],byTicker:{},protectedBy:{},open:null,quote:null,offered:{},tier:'balanced',how:false,adjust:false,cash:41250,
    tab:'Positions',parlays:null,parlaysErr:null,byParlay:{},lockedBy:{},openParlay:null,showSettled:false,expanded:{}};
  var TIER_ORDER=['tight','balanced','wide'];
  var TIER_WORDS={tight:'Safest',balanced:'Balanced',wide:'Most upside'};
  var MIN_CREDIT_CENTS=${Math.round(minCredit.cents)},MIN_CREDIT_BPS=${Number(minCredit.bpsOfStake)};
  var SPORTS_ONLY=${sportsOnly ? "true" : "false"};
  var SID=(function(){
    try{
      var k='epx_sid',v=sessionStorage.getItem(k);
      if(v&&/^[a-z0-9]{8,32}$/.test(v))return v;
      var a=new Uint8Array(12);(window.crypto||{}).getRandomValues?crypto.getRandomValues(a):a.forEach(function(_,i){a[i]=Math.floor(Math.random()*256)});
      v='';for(var i=0;i<a.length;i++)v+=(a[i]%36).toString(36);
      sessionStorage.setItem(k,v);return v;
    }catch(e){return 'anon'+Math.random().toString(36).slice(2,14)}
  })();
  function track(action,ticker,tier){
    try{
      var body=JSON.stringify({sid:SID,action:action,ticker:ticker||null,tier:tier||null});
      if(navigator.sendBeacon&&navigator.sendBeacon('/api/metrics',new Blob([body],{type:'application/json'})))return;
      fetch('/api/metrics',{method:'POST',body:body,keepalive:true,headers:{'content-type':'application/json'}}).catch(function(){});
    }catch(e){}
  }
  function usd(c){return (c/100).toLocaleString('en-US',{style:'currency',currency:'USD'})}
  /* whole dollars read as whole dollars: $150, not $150.00 */
  function usd0(c){return c%100===0?'$'+(c/100).toLocaleString('en-US'):usd(c)}
  function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})}
  function el(id){return document.getElementById(id)}
  var toastT=null;
  function toast(msg){var t=el('toast');t.textContent=msg;t.className='toast on';clearTimeout(toastT);toastT=setTimeout(function(){t.className='toast'},2400)}
  /* A weekday alone reads as "this Sunday"; past 24h out the date rides along so next week's game is never mistaken for today's. */
  function fmtEt(iso){
    try{
      var dt=new Date(iso),far=dt.getTime()-Date.now()>86400000;
      var day=dt.toLocaleDateString('en-US',far?{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'}:{weekday:'short',timeZone:'America/New_York'}).replace(',','');
      var tm=dt.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','');
      return day+(far?' · ':' ')+tm+' ET';
    }catch(e){return ''}
  }
  /* On a binary contract, floor F / cap C / credit K on n contracts is the same thing as keeping
     n*(C-F)/100 contracts and setting F*n + K aside in cash. The user only ever sees the two
     endings, floorTotal and capTotal, and the credit paid today; the rest is how it is built. */
  function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:F*n+K, floorTotal:F*n+K, capTotal:C*n+K}}
  /* the minimum-credit rule: 25¢ and 0.25% of stake, whichever is more */
  function worthIt(t,n){return !!t&&t.creditCents>=Math.max(MIN_CREDIT_CENTS,Math.round(n*100*MIN_CREDIT_BPS/10000))}
  function offeredTiers(q){
    var n=q.contracts,out={},k,i;
    if(q.tiers){for(i=0;i<TIER_ORDER.length;i++){k=TIER_ORDER[i];if(worthIt(q.tiers[k],n))out[k]=q.tiers[k]}}
    else if(worthIt(q,n)){out.balanced={floorCents:q.floorCents,capCents:q.capCents,creditCents:q.creditCents}}
    return out;
  }
  function defaultTier(offered){return offered.balanced?'balanced':offered.tight?'tight':offered.wide?'wide':null}

  function paintList(){
    if(S.tab==='Parlays'){paintParlays();return}
    var list=el('list');
    if(!S.rows.length){list.innerHTML='<div class="empty">'+esc(S.err||'No open positions to protect right now.')+'</div>';return}
    var html='';
    for(var i=0;i<S.rows.length;i++){
      var r=S.rows[i],p=S.protectedBy[r.kalshiTicker];
      var pl=(r.markCents-r.entryCents)*r.contracts;
      var when=r.kind==='crypto'?'settles '+fmtEt(r.eventTimeIso):fmtEt(r.eventTimeIso);
      html+='<div class="pos'+(p?' protected':'')+'" data-ticker="'+esc(r.kalshiTicker)+'">'+
        '<div class="h"><div><div class="name">'+esc(r.sideName)+'</div><div class="meta">'+esc(r.league.toUpperCase())+' · '+esc(when)+'</div></div>'+
        '<div class="pl '+(pl>0?'up':pl<0?'down':'')+'"><b>'+(pl>=0?'+':'-')+usd(Math.abs(pl))+'</b><i>'+r.markCents+'¢ now</i></div></div>';
      if(p&&p.closed){
        html+='<div class="terms">closed early · left with <b>'+usd(p.closed.leaveWithCents)+'</b> · vs <b>'+usd(p.closed.withoutProtectionCents)+'</b> without protection</div>'+
          '<div class="lock">a new trade at the live prices of '+esc(p.closed.at)+' · your '+usd(p.creditCents)+' credit stayed yours</div>'+
          '<div class="f"><span class="shield">&#x2713; Closed</span><button class="undo" data-undo="'+esc(r.kalshiTicker)+'">reset · demo only</button></div>';
      }else if(p){
        html+='<div class="terms">ends <b>'+usd(p.floorTotal)+'</b> or <b>'+usd(p.capTotal)+'</b> · <b>'+usd(p.creditCents)+'</b> paid now</div>'+
          '<div class="lock">locked at your tap · an early exit is a new trade at live prices</div>'+
          '<div class="f"><span class="shield">&#x2713; Protected</span><span class="acts"><button class="closeb" data-close="'+esc(r.kalshiTicker)+'">close early</button><button class="undo" data-undo="'+esc(r.kalshiTicker)+'">reset · demo only</button></span></div>';
      }else{
        html+='<div class="f"><span class="size">'+r.contracts+' contracts · ends $0 or '+usd0(100*r.contracts)+'</span>'+
          '<button class="pbtn" data-protect="'+esc(r.kalshiTicker)+'"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>Protect</button></div>';
      }
      html+='</div>';
    }
    list.innerHTML=html;
    el('bal').textContent='Cash '+usd(S.cash);
  }

  function openSheet(ticker){
    S.open=ticker;S.quote=null;S.offered={};S.how=false;S.adjust=false;
    el('scrim').className='scrim on';el('sheet').className='sheet on';
    var r=S.byTicker[ticker];
    el('sh-body').innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r?r.sideName:'')+' · '+(r?r.contracts:'')+' contracts</div><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:40%"></div>';
    track('row_tap',ticker);
    fetch('/api/showcase?ticker='+encodeURIComponent(ticker),{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      if(S.open!==ticker)return;
      S.quote=p&&p.quote?p.quote:null;
      if(S.quote&&S.quote.ok){S.offered=offeredTiers(S.quote);S.tier=defaultTier(S.offered)}
      paintSheet(p);
    }).catch(function(){if(S.open===ticker)paintSheet(null)});
  }
  function closeSheet(){S.open=null;S.openParlay=null;el('scrim').className='scrim';el('sheet').className='sheet'}

  function paintSheet(p){
    var r=S.byTicker[S.open]||{};
    var q=S.quote;
    var body=el('sh-body');
    var t=q&&q.ok&&S.tier?S.offered[S.tier]:null;
    if(!q||!q.ok||!t){
      var detail=q&&q.ok?'The market can\\'t fund a worthwhile credit on this one right now.':(q&&q.detail?q.detail:(p&&p.error?p.error:'Live pricing is unavailable right now.'));
      body.innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r.sideName||'')+'</div>'+
        '<div class="refusal"><b>Not right now.</b> '+esc(detail)+'</div>'+
        '<button class="go quiet" id="sh-close">Close</button>'+
        '<div class="fine">Protection is only offered when the market pays you for it.</div>';
      el('sh-close').onclick=closeSheet;return;
    }
    var n=q.contracts||r.contracts,rs=reshape(n,t.floorCents,t.capCents,t.creditCents);
    var keys=Object.keys(S.offered),chips='';
    if(keys.length>1){
      for(var i=0;i<TIER_ORDER.length;i++){var k=TIER_ORDER[i],tt=S.offered[k];if(!tt)continue;var tr=reshape(n,tt.floorCents,tt.capCents,tt.creditCents);
        chips+='<button class="chip" data-tier="'+k+'" aria-pressed="'+(k===S.tier)+'"><b>'+TIER_WORDS[k]+'</b>'+usd(tr.floorTotal)+' or '+usd(tr.capTotal)+'<br>+'+usd(tt.creditCents)+' now</button>';}
    }
    body.innerHTML='<h2 id="sh-h">Protect this position</h2><div class="who">'+esc(r.sideName||'')+' · '+n+' contracts · '+(r.markCents||q.markCents||'')+'¢ now</div>'+
      '<div class="tiles"><div class="tile"><div class="l">if it loses</div><div class="v">'+usd(rs.floorTotal)+'</div><div class="was">was $0</div></div>'+
      '<div class="tile k"><div class="l">paid now</div><div class="v">+'+usd(t.creditCents)+'</div><div class="was">yours today</div></div>'+
      '<div class="tile"><div class="l">if it wins</div><div class="v">'+usd(rs.capTotal)+'</div><div class="was">was '+usd0(100*n)+'</div></div></div>'+
      (chips?'<div class="chips'+(S.adjust?' on':'')+'" id="chips">'+chips+'</div>':'')+
      '<button class="go" id="sh-go">Protect · +'+usd(t.creditCents)+' now</button>'+
      '<div class="fine">priced live · locks at your tap'+(chips?' · <a href="#" id="sh-adjust">adjust</a>':'')+' · <a href="#" id="sh-how">how it works</a></div>'+
      '<div class="how'+(S.how?' on':'')+'" id="how"><p>You sell part of this position at today\\'s price and keep the rest. That is why you are paid now.</p><p>If '+esc(r.sideName||'your side')+' loses you end with '+usd(rs.floorTotal)+' instead of $0. If it wins, '+usd(rs.capTotal)+' instead of '+usd0(100*n)+'.</p><p>The credit you see is the credit you get. It settles on the same official result as your position; nothing to manage.</p><p>Terms lock at your tap; the other side is bought in the same second. Want out early? Tap close early on the card: a new trade priced from the live books, never a free reversal. The reset is demo only: nothing is bought here, so it simply clears the row.</p></div>';
    var cs=body.querySelectorAll('[data-tier]');
    for(var j=0;j<cs.length;j++)cs[j].onclick=function(){S.tier=this.getAttribute('data-tier');S.adjust=true;track('tier_pick',S.open,S.tier);paintSheet(p)};
    if(el('sh-adjust'))el('sh-adjust').onclick=function(e){e.preventDefault();S.adjust=!S.adjust;el('chips').className='chips'+(S.adjust?' on':'')};
    el('sh-how').onclick=function(e){e.preventDefault();S.how=!S.how;el('how').className='how'+(S.how?' on':'')};
    el('sh-go').onclick=function(){confirmProtect(q,n,t)};
  }

  function confirmProtect(q,n,t){
    var ticker=S.open,r=S.byTicker[ticker];
    var rs=reshape(n,t.floorCents,t.capCents,t.creditCents);
    S.protectedBy[ticker]={kept:rs.kept,cashCents:rs.cashCents,floorTotal:rs.floorTotal,capTotal:rs.capTotal,creditCents:t.creditCents,floorCents:t.floorCents,capCents:t.capCents,tier:S.tier,closed:null};
    S.cash+=t.creditCents;
    track('protect_on',ticker,S.tier);
    el('sh-body').innerHTML='<div class="done"><div class="ck">&#x2713;</div><h2 id="sh-h">Protected</h2>'+
      '<div class="sum">'+esc(r?r.sideName:'')+'<br>ends <b>'+usd(rs.floorTotal)+'</b> or <b>'+usd(rs.capTotal)+'</b><br><b>+'+usd(t.creditCents)+'</b> added to your cash</div></div>'+
      '<button class="go" id="sh-done">Done</button><div class="fine">Nothing to manage. It settles with your position.</div>';
    el('sh-done').onclick=function(){closeSheet();paintList()};
    paintList();
  }

  /* CLOSE EARLY: the other half of "terms lock at your tap". Leaving is a new trade priced from the
     live books this second: the user's contracts sold into the bids, the other side sold into its
     bids, the protection settled at what both fetched. The credit paid at the tap stays theirs. */
  function openCloseSheet(ticker){
    var p=S.protectedBy[ticker],r=S.byTicker[ticker];
    if(!p||p.closed)return;
    S.open=ticker;S.how=false;
    el('scrim').className='scrim on';el('sheet').className='sheet on';
    el('sh-body').innerHTML='<h2 id="sh-h">Leave early</h2><div class="who">'+esc(r?r.sideName:'')+' · '+(r?r.contracts:'')+' contracts</div><div class="skel"></div><div class="skel" style="width:70%"></div><div class="skel" style="width:40%"></div>';
    track('close_quote',ticker,p.tier);
    var qs='ticker='+encodeURIComponent(ticker)+'&floor='+p.floorCents+'&cap='+p.capCents+'&credit='+p.creditCents;
    fetch('/api/close-quote?'+qs,{cache:'no-store'}).then(function(x){return x.json()}).then(function(c){
      if(S.open!==ticker)return;
      paintCloseSheet(c,p,r);
    }).catch(function(){if(S.open===ticker)paintCloseSheet(null,p,r)});
  }
  function paintCloseSheet(c,p,r){
    var body=el('sh-body');
    if(!c||!c.ok){
      body.innerHTML='<h2 id="sh-h">Leave early</h2><div class="who">'+esc(r?r.sideName:'')+'</div>'+
        '<div class="refusal"><b>Not right now.</b> '+esc(c&&c.message?c.message:'Live pricing is unavailable right now. Your terms stay locked.')+'</div>'+
        '<button class="go quiet" id="sh-close">Keep it</button>'+
        '<div class="fine">Hold to the lock and it ends '+usd(p.floorTotal)+' or '+usd(p.capTotal)+', as quoted.</div>';
      el('sh-close').onclick=closeSheet;return;
    }
    var n=c.contracts||(r?r.contracts:0),mid=c.midCents!=null?c.midCents+'¢ now':'';
    var cost=c.costVsMidCents!=null?usd(Math.max(0,c.costVsMidCents)):null;
    body.innerHTML='<h2 id="sh-h">Leave early</h2><div class="who">'+esc(r?r.sideName:'')+' · '+n+' contracts'+(mid?' · '+mid:'')+'</div>'+
      '<div class="tiles"><div class="tile k"><div class="l">leave with</div><div class="v">'+usd(c.leaveWithCents)+'</div><div class="was">now, credit included</div></div>'+
      '<div class="tile"><div class="l">or hold</div><div class="v">'+usd(p.floorTotal)+'</div><div class="was">or '+usd(p.capTotal)+' at the lock</div></div>'+
      '<div class="tile"><div class="l">without protection</div><div class="v">'+usd(c.withoutProtectionCents)+'</div><div class="was">selling now</div></div></div>'+
      '<button class="go" id="sh-go">Close early · '+usd(c.leaveWithCents)+' now</button>'+
      '<div class="fine">priced live this second · a new trade, not a reversal · <a href="#" id="sh-how">how it works</a></div>'+
      '<div class="how'+(S.how?' on':'')+'" id="how"><p>You sell your contracts into the live bids and the other side is sold into its bids in the same second. The protection settles at what both fetched; the '+usd(p.creditCents)+' paid at your tap stays yours.</p>'+
      (cost?'<p>Leaving costs the spread on both sides: '+cost+' against the mid right now. Hold to the lock and there is no spread to pay.</p>':'')+
      '<p>Demo only: nothing is sold. The row closes and the cash lands in your balance.</p></div>';
    el('sh-how').onclick=function(e){e.preventDefault();S.how=!S.how;el('how').className='how'+(S.how?' on':'')};
    el('sh-go').onclick=function(){confirmClose(c,p,r)};
  }
  function confirmClose(c,p,r){
    var ticker=S.open,added=c.leaveWithCents-p.creditCents;
    p.closed={leaveWithCents:c.leaveWithCents,withoutProtectionCents:c.withoutProtectionCents,at:fmtNow(),addedCents:added};
    S.cash+=added;
    track('close_early',ticker,p.tier);
    el('sh-body').innerHTML='<div class="done"><div class="ck">&#x2713;</div><h2 id="sh-h">Closed</h2>'+
      '<div class="sum">'+esc(r?r.sideName:'')+'<br>left with <b>'+usd(c.leaveWithCents)+'</b> in total<br><b>'+(added>=0?'+':'-')+usd(Math.abs(added))+'</b> to your cash now, your <b>'+usd(p.creditCents)+'</b> credit already counted</div></div>'+
      '<button class="go" id="sh-done">Done</button><div class="fine">A new trade at live prices. Nothing left to settle.</div>';
    el('sh-done').onclick=function(){closeSheet();paintList()};
    paintList();
  }
  function fmtNow(){try{return new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET'}catch(e){return 'now'}}
  function fmtAt(iso){try{var d=new Date(iso);return d.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'})+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET'}catch(e){return ''}}

  /* PARLAYS: the shadow's simulated tickets, read through /api/parlays in retail shape. Three states
     on a row. Two or more picks open: no lock, and the row says so (there is no market for the pair of
     games, so nothing to price it against). One pick open: the lock priced from the live book at the
     moment, or the reason it was refused, a tap away in full. Settled or busted: one line under a
     collapsed Settled group, the full comparison on tap. The lock tap here is simulated on top of the
     shadow's terms; nothing is re-priced in the browser. */
  var PICK_MARK={hit:'&#x2713;',miss:'&#x2717;',open:'&middot;',partial:'&frac12;'};
  function parlayId(id){return String(id||'').toUpperCase()}
  /* "Cowboys vs Buccaneers": the side in ink, the rest of the matchup faint; soccer picks arrive as "Brighton to win" with nothing after */
  function pickHtml(p){
    var vs=p.versus==null?p.game:p.versus,v=vs?(/^(vs|at) /.test(vs)?' ':' &middot; ')+esc(vs):'';
    return '<div class="pick '+esc(p.state)+'"><i>'+PICK_MARK[p.state]+'</i><span><b>'+esc(p.outcome)+'</b>'+v+'</span><em>'+esc(p.state==='open'?fmtEt(p.startsIso):p.state)+'</em></div>';
  }
  function picksHtml(t){var h='<div class="picks">';for(var i=0;i<t.picks.length;i++)h+=pickHtml(t.picks[i]);return h+'</div>'}
  function leaguesOf(t){var seen={},out=[];for(var i=0;i<t.picks.length;i++){var l=String(t.picks[i].league||'').toUpperCase();if(l&&!seen[l]){seen[l]=1;out.push(l)}}return out.join(' &middot; ')}
  function missedPick(t){for(var j=0;j<t.picks.length;j++)if(t.picks[j].state==='miss')return t.picks[j];return null}
  function metaHtml(t){var win=t.paysCents-t.stakeCents,lg=leaguesOf(t);return usd0(t.stakeCents)+' to win '+usd0(win)+(lg?' &middot; '+lg:'')}
  function lockIcon(){return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>'}
  /* a ticket still in play: the full card */
  function inPlayHtml(t){
    var L=t.lock,locked=!!S.lockedBy[t.id],head='',foot='';
    if(t.state==='open'){
      head='<b>'+t.picksOpen+' picks open</b>';
      foot='<div class="f end"><button class="pbtn off" disabled>Protect unlocks at your last pick</button></div>';
    }else if(L&&locked){
      head='<b>worth '+usd(L.worthCents)+'</b> <i>&middot; '+L.hoursBefore+'h out</i>';
      foot='<div class="terms">ends <b>'+usd(L.floorTotalCents)+'</b> or <b>'+usd(L.capTotalCents)+'</b> &middot; <b>'+usd(L.creditCents)+'</b> paid now</div>'+
        '<div class="lock">locked at your tap &middot; terms priced '+esc(fmtAt(L.quotedAt))+' from the live book</div>'+
        '<div class="f"><span class="shield">&#x2713; Locked</span><button class="undo" data-unlock="'+esc(t.id)+'">reset &middot; demo only</button></div>';
    }else if(L){
      head='<b>worth '+usd(L.worthCents)+'</b> <i>&middot; '+L.hoursBefore+'h out</i>';
      foot='<div class="f"><button class="pbtn full" data-parlay="'+esc(t.id)+'">'+lockIcon()+'Lock in '+usd(L.floorTotalCents)+' &middot; '+usd(L.creditCents)+' paid now</button></div>';
    }else{
      head='<b>Last pick</b>';
      foot='<div class="f">'+(t.lockRefused
        ?'<button class="why" data-why="'+esc(t.id)+'">No lock right now: '+esc(t.lockRefusedShort||t.lockRefused)+'</button>'
        :'<span class="size">pricing the lock at the next pass</span>')+'<button class="pbtn off" disabled>Lock</button></div>';
    }
    return '<div class="pos parlay'+(locked?' protected':'')+'" data-tid="'+esc(t.id)+'"><div class="h"><div><div class="name">'+t.size+'-pick parlay</div><div class="meta">'+metaHtml(t)+'</div></div><div class="pl">'+head+'</div></div>'+picksHtml(t)+foot+'</div>';
  }
  /* a decided ticket: one line, the picks and the lock comparison on tap */
  function decidedHtml(t){
    var L=t.lock,R=t.result,open=!!S.expanded[t.id],head='',line='',more='',cls='';
    if(t.state==='settled'&&R){
      var hit=R.hit===true,net=R.ticketPaidCents-t.stakeCents;
      cls=hit?'up':R.hit===false?'down':'';
      head='<b>'+(net>=0?'+':'-')+usd0(Math.abs(net))+'</b> <i>&middot; '+(hit?'hit':R.hit==='partial'?'partial':'missed the last pick')+'</i>';
      line=R.lockPaidCents!=null?'ticket paid '+usd0(R.ticketPaidCents)+' &middot; locked '+usd0(R.lockPaidCents):'ticket paid '+usd0(R.ticketPaidCents)+' &middot; no lock priced';
      more='<div class="terms">'+(R.lockPaidCents!=null
        ?'ticket alone paid <b>'+usd(R.ticketPaidCents)+'</b> &middot; locked it would have paid <b>'+usd(R.lockPaidCents)+'</b>'+(L?' <i style="font-style:normal;color:var(--faint)">(incl. '+usd(L.creditCents)+' at the tap)</i>':'')
        :'ticket paid <b>'+usd(R.ticketPaidCents)+'</b> &middot; no lock was priced before the last game')+'</div>';
    }else if(t.state==='busted'){
      var miss=missedPick(t);
      cls='down';
      head='<b>-'+usd0(t.stakeCents)+'</b> <i>&middot; busted</i>';
      line=(miss?'busted on '+esc(miss.outcome)+' &middot; ':'')+'ticket paid $0';
      more='<div class="terms">'+(miss?'busted on <b>'+esc(miss.outcome)+'</b> &middot; ':'')+'ticket paid <b>$0</b> &middot; no lock exists before the last pick</div>';
    }else{
      head='<b>void</b> <i>&middot; no result</i>';
      line='the venue settled no result';
    }
    return '<div class="pos parlay mini" data-expand="'+esc(t.id)+'" data-tid="'+esc(t.id)+'"><div class="h"><div><div class="name">'+t.size+'-pick parlay</div><div class="meta">'+(open?metaHtml(t):line)+'</div></div><div class="pl '+cls+'">'+head+'</div></div>'+(open?picksHtml(t)+more:'')+'</div>';
  }
  function paintParlays(){
    var list=el('list'),P=S.parlays;
    if(!P){list.innerHTML='<div class="empty">'+esc(S.parlaysErr||'loading your parlays…')+'</div>';return}
    var rows=P.tickets||[],live=[],done=[],i;
    for(i=0;i<rows.length;i++)(rows[i].state==='open'||rows[i].state==='last_pick'?live:done).push(rows[i]);
    var html='<div class="note"><span>Simulated tickets at live prices; nothing is bought.</span><button class="info" data-info="1" aria-label="About these tickets">i</button></div>';
    if(!rows.length){list.innerHTML=html+'<div class="empty">No parlay tickets yet. New ones are built from the week\\'s slate.</div>';return}
    if(live.length){html+='<div class="grp"><span>In play</span></div>';for(i=0;i<live.length;i++)html+=inPlayHtml(live[i])}
    else html+='<div class="empty">Nothing in play right now. New tickets are built from the week\\'s slate.</div>';
    if(done.length){
      html+='<div class="grp"><span>Settled &middot; '+done.length+'</span><button data-settled="1">'+(S.showSettled?'Hide':'Show')+'</button></div>';
      if(S.showSettled)for(i=0;i<done.length;i++)html+=decidedHtml(done[i]);
    }
    list.innerHTML=html;
    el('bal').textContent='Cash '+usd(S.cash);
  }
  function openPlainSheet(key,body){
    S.openParlay=key;S.open=null;S.how=false;
    el('scrim').className='scrim on';el('sheet').className='sheet on';
    el('sh-body').innerHTML=body+'<button class="go quiet" id="sh-done">Got it</button>';
    el('sh-done').onclick=closeSheet;
  }
  /* the long version of the one-line note at the top of the tab */
  function openInfoSheet(){
    var P=S.parlays||{};
    openPlainSheet('info','<h2 id="sh-h">About these tickets</h2>'+
      '<div class="how on"><p>These tickets are ours, not copied from anyone. Each is 2 to 5 favourites at '+usd0(P.stakeCents||2000)+', built from public game markets at the prices when it was built.</p>'+
      '<p>The lock is priced from the live market on the last pick and refreshed every '+(P.pricedEveryMinutes||10)+' minutes. It is offered only when one pick is left: with two picks open there is no market for the pair of games.</p>'+
      '<p>Nothing is bought.</p></div>');
  }
  /* the refusal in full, behind the one-line reason on the row */
  function openWhySheet(id){
    var t=S.byParlay[id];if(!t||!t.lockRefused)return;
    var last=t.picks[t.picks.length-1],P=S.parlays||{};
    openPlainSheet(id,'<h2 id="sh-h">No lock right now</h2><div class="who">'+esc(last.outcome)+' is the last pick</div>'+
      '<div class="refusal">'+esc(t.lockRefused.charAt(0).toUpperCase()+t.lockRefused.slice(1))+'.</div>'+
      '<div class="how on"><p>The lock is re-priced every '+(P.pricedEveryMinutes||10)+' minutes while the last game is still ahead. When the market can fund it, the button lights up on this row.</p></div>');
  }
  function openParlaySheet(id){
    var t=S.byParlay[id];if(!t||!t.lock)return;
    var L=t.lock,last=t.picks[t.picks.length-1];
    S.openParlay=id;S.open=null;S.how=false;
    el('scrim').className='scrim on';el('sheet').className='sheet on';
    track('parlay_tap',parlayId(id));
    el('sh-body').innerHTML='<h2 id="sh-h">Lock in your parlay</h2><div class="who">'+esc(last.outcome)+' is the last pick &middot; worth '+usd(L.worthCents)+' at fair</div>'+
      '<div class="tiles"><div class="tile"><div class="l">if it misses</div><div class="v">'+usd(L.floorTotalCents)+'</div><div class="was">was $0</div></div>'+
      '<div class="tile k"><div class="l">paid now</div><div class="v">+'+usd(L.creditCents)+'</div><div class="was">yours today</div></div>'+
      '<div class="tile"><div class="l">if it hits</div><div class="v">'+usd(L.capTotalCents)+'</div><div class="was">was '+usd(t.paysCents)+'</div></div></div>'+
      '<button class="go" id="sh-go">Lock in '+usd(L.floorTotalCents)+' &middot; +'+usd(L.creditCents)+' now</button>'+
      '<div class="fine">priced '+esc(fmtAt(L.quotedAt))+' from the live book, '+L.hoursBefore+'h before the game &middot; <a href="#" id="sh-how">how it works</a></div>'+
      '<div class="how" id="how"><p>Cash out sells the whole ticket at the venue\\'s price. The lock keeps the ticket: it guarantees '+usd(L.floorTotalCents)+' if '+esc(last.outcome)+' misses, pays '+usd(L.creditCents)+' now, and leaves the upside to '+usd(L.capTotalCents)+' if it hits.</p>'+
      '<p>It is priced only when one pick is left. With two picks open there is no market for the pair of games, so no lock is offered yet.</p>'+
      '<p>The ticket is ours, built from public game markets at the prices when it was built. The terms are the ones the live market on the last pick funded at that second; nothing is bought.</p></div>';
    el('sh-how').onclick=function(e){e.preventDefault();S.how=!S.how;el('how').className='how'+(S.how?' on':'')};
    el('sh-go').onclick=function(){confirmParlayLock(t)};
  }
  function confirmParlayLock(t){
    var L=t.lock;
    S.lockedBy[t.id]=true;S.cash+=L.creditCents;
    track('parlay_lock',parlayId(t.id));
    el('sh-body').innerHTML='<div class="done"><div class="ck">&#x2713;</div><h2 id="sh-h">Locked</h2>'+
      '<div class="sum">'+t.size+'-pick parlay<br>ends <b>'+usd(L.floorTotalCents)+'</b> or <b>'+usd(L.capTotalCents)+'</b><br><b>+'+usd(L.creditCents)+'</b> added to your cash</div></div>'+
      '<button class="go" id="sh-done">Done</button><div class="fine">Nothing to manage. It settles with the last pick.</div>';
    el('sh-done').onclick=function(){closeSheet();paintList()};
    paintList();
  }
  function switchTab(tab){
    if(S.tab===tab)return;
    S.tab=tab;
    var ts=document.querySelectorAll('.tabs span');
    for(var i=0;i<ts.length;i++)ts[i].className=ts[i].getAttribute('data-tab')===tab?'on':'';
    if(tab==='Parlays'){track('parlay_tab');if(!S.parlays)loadParlays()}
    paintList();
  }
  function loadParlays(){
    fetch('/api/parlays',{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      if(!p||!p.ok){S.parlays=null;S.parlaysErr=(p&&p.error)||'Parlays are unavailable right now.';if(S.tab==='Parlays')paintList();return}
      S.parlays=p;S.parlaysErr=null;S.byParlay={};
      var rows=p.tickets||[];for(var i=0;i<rows.length;i++)S.byParlay[rows[i].id]=rows[i];
      if(S.tab==='Parlays')paintList();
    }).catch(function(){S.parlays=null;S.parlaysErr='Parlays are unavailable right now.';if(S.tab==='Parlays')paintList()});
  }

  document.addEventListener('click',function(e){
    var b=e.target.closest?e.target.closest('[data-protect],[data-undo],[data-close],[data-tab],[data-parlay],[data-unlock],[data-info],[data-why],[data-settled],[data-expand]'):null;
    if(!b)return;
    if(b.hasAttribute('data-info')){openInfoSheet();return}
    var why=b.getAttribute('data-why');
    if(why){openWhySheet(why);return}
    if(b.hasAttribute('data-settled')){S.showSettled=!S.showSettled;paintList();return}
    var ex=b.getAttribute('data-expand');
    if(ex){S.expanded[ex]=!S.expanded[ex];paintList();return}
    var t=b.getAttribute('data-protect');
    if(t){openSheet(t);return}
    var c=b.getAttribute('data-close');
    if(c){openCloseSheet(c);return}
    var u=b.getAttribute('data-undo');
    if(u&&S.protectedBy[u]){var pu=S.protectedBy[u];S.cash-=pu.creditCents;if(pu.closed)S.cash-=pu.closed.addedCents;delete S.protectedBy[u];track('protect_undo',u);paintList();return}
    var pid=b.getAttribute('data-parlay');
    if(pid){openParlaySheet(pid);return}
    var ul=b.getAttribute('data-unlock');
    if(ul&&S.lockedBy[ul]){var lt=S.byParlay[ul];if(lt&&lt.lock)S.cash-=lt.lock.creditCents;delete S.lockedBy[ul];paintList();return}
    var tab=b.getAttribute('data-tab');
    if(tab==='Positions'||tab==='Parlays'){switchTab(tab);return}
    if(tab)toast('Demo: Positions and Parlays are live here.');
  });
  el('scrim').onclick=closeSheet;

  function load(){
    fetch('/api/showcase',{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      var rows=(p&&p.board)||[];
      if(SPORTS_ONLY)rows=rows.filter(function(r){return r.kind!=='crypto'});
      S.rows=rows;S.byTicker={};
      for(var i=0;i<rows.length;i++)S.byTicker[rows[i].kalshiTicker]=rows[i];
      S.err=rows.length?null:(p&&p.error)||null;
      paintList();
    }).catch(function(){S.rows=[];S.err='Positions are unavailable right now.';paintList()});
  }
  load();
  /* ?tab=parlays opens on the Parlays tab, so a link can land a partner on the parlay rows directly */
  try{if(/[?&]tab=parlays\\b/i.test(location.search))switchTab('Parlays')}catch(e){}
  setInterval(function(){if(S.open||S.openParlay)return;if(S.tab==='Parlays')loadParlays();else load()},60000);
})();
</script>
</body>
</html>`;
}

export interface PartnerConsoleInput {
  atIso: string;
  brand: string;
  ledger: CrossLedgerSummary;
  funnel: EventFunnelSummary;
  /** the partner's share of the published take, percent */
  sharePct: number;
  maxEvCostBps: number;
}

const usd = (c: number): string => `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (bps: number | null, digits = 2): string => (bps === null ? "–" : `${(bps / 100).toFixed(digits)}%`);

/** Public words for a hedge route, for the partner: on their book or off it. */
const PARTNER_ROUTE_WORDS: Record<string, string> = {
  kalshi_self: "priced on the market's own No side",
  polymarket: "priced cross-venue on the same game",
};

const PARTNER_REFUSAL_WORDS: Record<string, string> = {
  credit_nonpositive: "the market could not fund a credit",
  protection_too_rich: "protection would have cost more than our ceiling",
  credit_too_small: "the credit fell under our minimum",
  pm_book_empty: "no depth to hedge",
  pm_book_too_thin: "not enough depth for the size",
  kalshi_book_empty: "no depth on the market's No side",
  kalshi_book_too_thin: "not enough depth on the market's No side",
  market_too_close_to_start: "too close to the start",
  mark_out_of_range: "odds outside the range we protect",
  no_matched_market: "no verified pairing",
  resolution_mismatch: "settlement rules did not match",
};

/**
 * PARTNER CONSOLE — what a host sees about the layer running on their users.
 * Volume protected, credits paid to their users, what the protection cost,
 * how much of it was priced on their own book, what was refused and why, and
 * their share of the take. Operator token only: it names our take.
 */
export function renderPartnerHtml(input: PartnerConsoleInput): string {
  const l = input.ledger;
  const f = input.funnel;
  const total = l.priced + l.refused;
  const fill = total > 0 ? `${Math.round((l.priced / total) * 100)}%` : "–";
  const partnerShareCents = Math.round((l.takeKeptCents * input.sharePct) / 100);
  const ownBook = l.routeSplit.kalshi_self ?? 0;
  const ownPct = l.priced > 0 ? `${Math.round((ownBook / l.priced) * 100)}%` : "–";
  const routeRows = Object.entries(l.routeSplit)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `<div class="row"><span>${escapeHtml(PARTNER_ROUTE_WORDS[r] ?? r)}</span><b>${n}</b></div>`)
    .join("");
  const refusalRows = Object.entries(l.refusalsByCode)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `<div class="row"><span>${escapeHtml(PARTNER_REFUSAL_WORDS[c] ?? c.replace(/_/g, " "))}</span><b>${n}</b></div>`)
    .join("");
  const tierRows = Object.entries(f.protects.byTier)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `<div class="row"><span>${escapeHtml(t)}</span><b>${n}</b></div>`)
    .join("");
  const embedLoads = f.pageLoads7d.reduce((n, d) => n + (d.byPage.embed ?? 0), 0);
  const period = l.firstAt ? `${l.firstAt.slice(0, 10)} to ${l.lastAt?.slice(0, 10) ?? l.firstAt.slice(0, 10)} UTC` : "no quotes recorded yet";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>Partner console · ${escapeHtml(input.brand)} · Earn &amp; Protect</title>
<style>
:root{--bg:#f6f7f7;--card:#fff;--card2:#f2f4f4;--line:#e4e7e7;--ink:#050d0a;--dim:#5c6a64;--faint:#98a49e;--green:#00b67a;--deep:#014737}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#fff;border-bottom:1px solid var(--line)}.topbar .in{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 16px}
.topbar .wordmark{color:var(--ink);font-weight:650;font-size:14px}.topbar .wordmark span{color:var(--faint);font-weight:400}
.topbar img{height:18px;display:block}
.wrap{max-width:640px;margin:0 auto;padding:14px 14px 40px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin-bottom:12px}
h1{font-size:20px;font-weight:700;letter-spacing:-.01em}h2{font-size:14px;font-weight:700;margin-bottom:6px}
.sub{color:var(--dim);font-size:13px;line-height:1.5;margin-top:4px}
.bignums{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:12px}
@media(min-width:520px){.bignums{grid-template-columns:repeat(4,1fr)}}
.bignum{background:var(--card2);border-radius:12px;padding:10px 12px}
.bignum .n{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums;letter-spacing:-.01em}.bignum .n.green{color:var(--green)}
.bignum .l{color:var(--dim);font-size:11.5px;margin-top:2px}
.row{display:flex;justify-content:space-between;gap:12px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13.5px}
.row:last-child{border-bottom:0}.row span{color:var(--dim)}.row b{font-weight:650;font-variant-numeric:tabular-nums;text-align:right}
.row b i{font-style:normal;color:var(--faint);font-weight:400;font-size:12px}
.period{color:var(--dim);font-size:12px;margin-top:10px}
.rule{color:var(--faint);font-size:11.5px;margin-top:8px;line-height:1.45}
a{color:var(--dim)}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· partner console · ${escapeHtml(input.brand)}</span></div>
  <img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <div class="card">
    <h1>The layer on your users' positions</h1>
    <div class="sub">Every quote the layer wrote for positions on your board, what it paid your users, what it cost them in expected value, and your share. Quotes are live; positions are simulated until the integration is on.</div>
    <div class="bignums">
      <div class="bignum"><div class="n">${usd(l.stakeQuotedCents)}</div><div class="l">volume protected</div></div>
      <div class="bignum"><div class="n green">${usd(l.creditsSourcedCents)}</div><div class="l">credits paid to your users</div></div>
      <div class="bignum"><div class="n">${escapeHtml(pct(l.avgEvCostBps))}</div><div class="l">average cost of protection</div></div>
      <div class="bignum"><div class="n green">${usd(partnerShareCents)}</div><div class="l">your share (${input.sharePct}% of take)</div></div>
    </div>
    <div class="period">${escapeHtml(period)}</div>
  </div>
  <div class="card">
    <h2>Quotes</h2>
    <div class="row"><span>priced</span><b>${l.priced} <i>of ${total} · ${fill} fill</i></b></div>
    <div class="row"><span>priced on your own book</span><b>${ownBook} <i>${ownPct}</i></b></div>
    ${routeRows}
    <div class="row"><span>ceiling on cost of protection</span><b>${escapeHtml(pct(input.maxEvCostBps))} <i>of expected value</i></b></div>
    <div class="rule">Above the ceiling the layer refuses rather than quotes rich insurance; refusals are counted, not hidden.</div>
  </div>
  <div class="card">
    <h2>Refused, and why</h2>
    ${refusalRows || '<div class="row"><span>nothing refused yet</span><b>–</b></div>'}
  </div>
  <div class="card">
    <h2>Your users</h2>
    <div class="row"><span>Protect taps (all pages)</span><b>${f.protects.total} <i>${f.protects.last7d} in 7 days</i></b></div>
    <div class="row"><span>credits on those taps</span><b>${usd(f.protects.creditCentsTotal)}</b></div>
    <div class="row"><span>contracts protected on those taps</span><b>${f.protects.contractsTotal}</b></div>
    <div class="row"><span>embedded shell loads, 7 days</span><b>${embedLoads}</b></div>
    ${tierRows ? `<div class="rule" style="margin-top:10px">Protection tier chosen</div>${tierRows}` : ""}
  </div>
  <div class="card">
    <h2>Integration</h2>
    <div class="row"><span>who does what</span><b>we price and hedge <i>your venue executes and settles</i></b></div>
    <div class="row"><span>surface</span><b>one button per position row</b></div>
    <div class="row"><span>settlement</span><b>your official result, same as the position</b></div>
    <div class="row"><span>revenue share</span><b>${input.sharePct}% of the published take</b></div>
    <div class="rule">The published take is already netted out of every credit shown to a user: the credit they see is the credit they get. <a href="/embed">See the embedded shell</a> · <a href="/receipts">Receipts</a></div>
  </div>
</div>
</body>
</html>`;
}

export interface PartnerCtaInput {
  brand: string;
  /** where "Talk to us" goes */
  contactEmail: string;
  trackRecordUrl: string;
}

/**
 * PARTNER PAGE, PUBLIC — what /partner shows without an operator token. The console itself names
 * our take, so it stays behind the token; a visitor who follows the link gets the pitch for it
 * (what a partner sees, what they get) and one call to action, not a JSON error.
 */
export function renderPartnerCtaHtml(input: PartnerCtaInput): string {
  const email = escapeHtml(input.contactEmail);
  const subject = encodeURIComponent(`Protection inside ${input.brand === DEFAULT_EMBED_BRAND ? "our app" : input.brand}`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Partner console · Earn &amp; Protect</title>
<style>
:root{--bg:#f6f7f7;--card:#fff;--line:#e4e7e7;--ink:#050d0a;--dim:#5c6a64;--faint:#98a49e;--green:#00b67a}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;min-height:100vh}
.topbar{background:#fff;border-bottom:1px solid var(--line)}.topbar .in{max-width:640px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;padding:12px 16px}
.topbar .wordmark{color:var(--ink);font-weight:650;font-size:14px}.topbar .wordmark span{color:var(--faint);font-weight:400}
.topbar img{height:18px;display:block}
.wrap{max-width:640px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:28px;line-height:1.15;letter-spacing:-.02em;font-weight:700}
.sub{color:var(--dim);font-size:15px;margin-top:10px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-top:22px}
.card h2{font-size:13px;font-weight:700;color:var(--dim);text-transform:uppercase;letter-spacing:.04em;margin-bottom:8px}
.card li{list-style:none;padding:7px 0;border-bottom:1px solid var(--line);font-size:14.5px}.card li:last-child{border-bottom:0}
.card li b{font-weight:650}
.cta{display:inline-block;margin-top:22px;background:var(--green);color:#fff;font-weight:700;font-size:15px;padding:13px 22px;border-radius:12px;text-decoration:none}
.cta:hover{filter:brightness(.96)}
.also{margin-top:14px;font-size:13px;color:var(--dim)}.also a{color:var(--ink)}
.foot{margin-top:36px;color:var(--faint);font-size:12px}
</style>
</head>
<body>
<div class="topbar"><div class="in">
  <div class="wordmark">Earn &amp; Protect <span>· partner console</span></div>
  <img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" />
</div></div>
<div class="wrap">
  <h1>The console your team gets.</h1>
  <div class="sub">One page, live, for the layer running on your users' positions. We price and hedge; your venue executes and settles.</div>
  <div class="card">
    <h2>What it shows</h2>
    <ul>
      <li><b>Volume protected</b> and credits paid to your users, by day</li>
      <li><b>What protection cost</b> your users in expected value, against our ceiling</li>
      <li><b>Where it was priced</b>: on your own book, or cross-venue on the same game</li>
      <li><b>What we refused</b>, and why, one line per reason</li>
      <li><b>Your share</b> of the take, to the cent</li>
    </ul>
  </div>
  <div class="card">
    <h2>What integration takes</h2>
    <ul>
      <li>One JSON quote in, one receipt out</li>
      <li>Your brand, your ledger, your official result</li>
      <li>A Protect button on the position row; we supply the sheet</li>
    </ul>
  </div>
  <a class="cta" href="mailto:${email}?subject=${subject}">Talk to us</a>
  <div class="also">Or see the <a href="${escapeHtml(input.trackRecordUrl)}">track record</a> first: every quote, every settlement, our P&amp;L against the take we booked.</div>
  <div class="foot">Demonstration only. Simulated positions at live prices; nothing is bought.</div>
</div>
</body>
</html>`;
}
