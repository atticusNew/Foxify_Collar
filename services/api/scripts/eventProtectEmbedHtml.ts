/**
 * EMBED DEMO — the protection layer inside somebody else's app.
 *
 * The pitch to a prediction market or broker is not "send your users to our
 * page"; it is "one button on your positions list". This page is that pitch,
 * runnable: a host shell (a brand's positions list, their colours, their
 * wordmark) with our Lock in button on every row. Tapping it opens the sheet,
 * priced live from the same scan as the public board; one more tap and the
 * row reshapes to what the lock really is on a binary contract: the position
 * now ends at a floor or a cap, and part of it was paid today. Nothing leaves
 * the host.
 *
 * The bettor's verb is "Lock in", never "Protect": on a positions list,
 * Protect reads as the house conceding its product needs protecting, and it
 * names only the floor. Lock in is the bettor acting on a winner and names the
 * floor and the cash. Earn & Protect stays the name of the line; the sheet's
 * eyebrow "protection by Atticus" stays, because it names us, not the tap.
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
 * The Positions list is grouped by league (crypto last) so it reads like a
 * real app's, and the Activity tab is real: this session's own taps on top,
 * then the record's finished positions (/api/activity, a retail cut of the
 * shadow's public /api/shadow) as what each ended at with the lock against
 * without. There is no Markets tab: browsing and buying is the host's product.
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
import { prettyPhone, type CardContact } from "../src/eventCollar/crossVenue/cardContact";

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
  /**
   * The live recording: a real position on ProphetX locked in one tap, the other side bought on
   * Novig, shown in the pitch column under the try line. `null` leaves the block out.
   */
  liveVideo?: LiveVideo | null;
  /**
   * The business card's landing (`?from=card`). A phone that scanned the card gets the sentence,
   * the clip, "Save contact" (a vCard) and the links instead of landing cold inside the demo;
   * a desktop still gets the full page. `null`/absent renders the page as usual.
   */
  card?: CardContact | null;
}

export interface LiveVideo {
  /** the mp4's URL, absolute or on this host */
  src: string;
  /** the still shown before play */
  poster: string;
}

/** Where the demo page's live recording is served by default (the service's own /media route). */
export const DEFAULT_LIVE_VIDEO: LiveVideo = { src: "/media/lockin-live.mp4", poster: "/media/lockin-live.jpg" };

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

/**
 * What a phone sees after scanning the card: who this is, the clip, Save contact, Try the demo,
 * and the links. The demo link drops `from=card` so the tap lands in the positions list as usual.
 */
function renderCardLanding(c: CardContact, video: LiveVideo | null, trackRecordUrl: string, recordLabel: string, brandQ: string): string {
  const name = escapeHtml(`${c.givenName} ${c.familyName}`.trim());
  const videoBlock = video
    ? `<video controls preload="metadata" playsinline poster="${escapeHtml(video.poster)}" src="${escapeHtml(video.src)}"></video>` +
      `<p class="cl-cap"><b>Seen live on a real position, locked in one tap; the receipt names the venue that took the other side.</b> Shown through a browser extension on the venues' pages. Not affiliated with or endorsed by any venue.</p>`
    : "";
  return `<section class="cardland"><div class="in">
  <img class="cl-logo" src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" />
  <div class="cl-eyebrow">Earn &amp; Protect</div>
  <h1>The <b>Lock in</b> button.</h1>
  <p class="cl-lede">One tap gives any open position a floor and cash now. Priced across venues, hedged leg for leg on the cheaper book; refused when no book can fund it. Every quote, hedge, refusal and result on a public record.</p>
  ${videoBlock}
  <div class="cl-btns"><a class="cl-btn cl-primary" href="/contact.vcf" download>Save contact</a><a class="cl-btn" href="/${brandQ}">Try the demo: tap Lock in on a position</a></div>
  <div class="cl-links"><a href="${escapeHtml(c.linkedin)}">LinkedIn</a><a href="mailto:${escapeHtml(c.email)}">Email</a><a href="https://wa.me/${escapeHtml(c.phoneE164.replace(/^\+/, ""))}">WhatsApp</a><a href="${trackRecordUrl}">${recordLabel}</a></div>
  <div class="cl-who"><b>${name}</b>${escapeHtml(c.title)}, ${escapeHtml(c.org)}<br><a href="tel:${escapeHtml(c.phoneE164)}">${escapeHtml(prettyPhone(c.phoneE164))}</a> · <a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a></div>
</div></section>
`;
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
  const video = opts.liveVideo === undefined ? DEFAULT_LIVE_VIDEO : opts.liveVideo;
  // the recording: a shared link previews it, and the pitch column plays it on tap, never on its own
  const videoMeta = video ? `\n<meta property="og:video" content="${escapeHtml(video.src)}" />\n<meta property="og:video:type" content="video/mp4" />\n<meta property="og:image" content="${escapeHtml(video.poster)}" />` : "";
  const videoBlock = video
    ? `<div class="live"><div class="live-h">Seen live</div>` +
      `<video controls preload="none" playsinline poster="${escapeHtml(video.poster)}" src="${escapeHtml(video.src)}"></video>` +
      `<p>A real position on ProphetX, locked in one tap. The other side was bought on Novig, the best price of the venues that quoted it; the receipt names both.</p>` +
      `<p class="live-fine">Shown through a browser extension on the venues' pages. Not affiliated with or endorsed by any venue.</p></div>`
    : "";
  const card = opts.card ?? null;
  const cardBlock = card ? renderCardLanding(card, video, trackRecordUrl, recordLabel, brandQ) : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex" />
<link rel="icon" href="data:," />
<title>${brand} · Positions</title>
<meta name="description" content="One tap. Any prediction market. How Earn &amp; Protect sits inside a venue's positions list: one Lock in line per row, priced across venues, hedged where it is cheapest. Demonstration; positions are simulated, prices are live." />${videoMeta}
<style>
:root{
  ${
    dark
      ? `--bg:#0f1115; --card:#171a21; --card2:#1d212a; --line:#262b36; --ink:#f3f5f8; --dim:#9aa3b2; --faint:#6b7382; --up:#3ccf91; --down:#ff6b6b; --frame:rgba(255,255,255,.14); --wash:rgba(255,255,255,.06);`
      : `--bg:#f4f5f7; --card:#ffffff; --card2:#f7f8fa; --line:#e6e8ec; --ink:#0f1115; --dim:#5f6775; --faint:#98a0ad; --up:#1d9a63; --down:#d64545; --frame:rgba(0,0,0,.12); --wash:rgba(0,0,0,.04);`
  }
  --accent:${theme.accent}; --accent-ink:${theme.accentInk};
  --stage:#eceef2; --stage-ink:#0f1115; --stage-dim:#5f6775;
  --ep-green:#00b67a; --gold:#C9A227;
}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{background:var(--bg);color:var(--ink);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
.stage{min-height:100vh}
.pitch{display:none}
/* ---- the card's landing: a phone that scanned the card sees this instead of the demo ---- */
.cardland{display:none}
.stage.from-card .cardland{display:block;background:#0a0a0b;color:#e9e6dc;min-height:100vh;padding:34px 22px calc(40px + env(safe-area-inset-bottom))}
.stage.from-card .demo{display:none}
.cardland .in{max-width:460px;margin:0 auto}
.cardland .cl-logo{height:30px;display:block}
.cardland .cl-eyebrow{margin-top:12px;font-size:11px;font-weight:700;letter-spacing:.22em;text-transform:uppercase;color:#C9A227}
.cardland h1{margin-top:22px;font-size:30px;line-height:1.1;letter-spacing:-.02em;font-weight:700;color:#f6f3ea}
.cardland h1 b{color:#2ec27e}
.cardland .cl-lede{margin-top:12px;font-size:16px;line-height:1.5;color:#c9c6bc}
.cardland video{display:block;width:100%;aspect-ratio:16/9;margin-top:22px;border-radius:12px;background:#0e0e10}
.cardland .cl-cap{margin-top:10px;font-size:12.5px;line-height:1.45;color:#8e8b82}
.cardland .cl-cap b{color:#c9c6bc;font-weight:600}
.cardland .cl-btns{display:grid;gap:10px;margin-top:24px}
.cardland .cl-btn{display:block;text-align:center;padding:15px 16px;border-radius:12px;font-size:16px;font-weight:700;text-decoration:none;border:1px solid rgba(201,162,39,.55);color:#f6f3ea}
.cardland .cl-btn.cl-primary{background:#C9A227;border-color:#C9A227;color:#1a1507}
.cardland .cl-links{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:22px;font-size:14px}
.cardland .cl-links a{color:#e9e6dc;text-decoration:none;border-bottom:1px solid rgba(233,230,220,.35);padding-bottom:1px}
.cardland .cl-who{margin-top:26px;padding-top:16px;border-top:1px solid rgba(255,255,255,.1);font-size:13.5px;line-height:1.6;color:#9a978d}
.cardland .cl-who b{display:block;color:#f6f3ea;font-weight:600;font-size:15px}
.cardland .cl-who a{color:#c9c6bc;text-decoration:none}
/* ---- the controls above the mock: which shell, whose view ---- */
.ctl{display:flex;align-items:center;justify-content:center;gap:10px;padding:10px 12px 0;flex-wrap:wrap}
.seg{display:inline-flex;border:1px solid var(--line);border-radius:999px;padding:2px;background:var(--card);gap:2px}
.seg button{appearance:none;border:1px solid transparent;border-radius:999px;background:transparent;color:var(--dim);font:inherit;font-size:12.5px;font-weight:600;padding:5px 12px;cursor:pointer;white-space:nowrap}
.seg button[aria-pressed="true"]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.seg.shellseg{display:none}
/* ---- the phone shell ---- */
.phone{max-width:430px;margin:0 auto;min-height:100vh;background:var(--bg);position:relative}
.host-top{padding:14px 16px 8px;display:flex;align-items:center;justify-content:space-between}
.brand{font-weight:700;font-size:17px;letter-spacing:-.01em;display:flex;align-items:center;gap:8px}
.brand i{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:7px;background:var(--accent);color:var(--accent-ink);font-style:normal;font-size:12px;font-weight:800}
.bal{display:flex;align-items:center;gap:6px;font-variant-numeric:tabular-nums;font-size:13px;color:var(--dim)}
.delta{font-style:normal;font-weight:700;font-size:12px;color:var(--up);opacity:0}
.delta.down{color:var(--down)}
.delta.on{animation:delta 1.8s ease-out forwards}
@keyframes delta{0%{opacity:0;transform:translateY(5px)}15%{opacity:1;transform:none}70%{opacity:1;transform:none}100%{opacity:0;transform:translateY(-5px)}}
.tabs{display:flex;gap:18px;padding:0 16px;border-bottom:1px solid var(--line)}
.tabs span{padding:8px 0 10px;font-size:14px;color:var(--faint);font-weight:600;cursor:pointer;user-select:none}
.tabs span.on{color:var(--ink);border-bottom:2px solid var(--accent);cursor:default}
.list{padding:8px 12px 120px}
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
/* the position's own facts, as a venue prints them: stake, price, payout, placed */
.pos .facts{display:flex;gap:14px;margin-top:9px;padding-top:8px;border-top:1px solid var(--line);font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;flex-wrap:wrap}
.pos .facts span b{display:block;color:var(--ink);font-weight:600;font-size:13px}
.pos.has-line{padding-bottom:12px}
.pbtn{appearance:none;border:0;border-radius:999px;padding:7px 13px;font:inherit;font-size:13px;font-weight:700;cursor:pointer;background:var(--accent);color:var(--accent-ink);display:inline-flex;align-items:center;gap:6px}
.pbtn:disabled{opacity:.6;cursor:default}
.pbtn svg{width:13px;height:13px}
.pbtn.off{background:var(--card2);color:var(--faint);box-shadow:none;cursor:default;border:1px solid var(--line)}
.pbtn.full{flex:1;justify-content:center;padding:9px 13px}
.pos.protected{border-color:var(--accent)}
.pos .shield{display:inline-flex;align-items:center;gap:5px;background:var(--wash);color:var(--accent);font-size:12px;font-weight:700;border-radius:999px;padding:3px 9px}
.pos .shield.grey{background:var(--card2);color:var(--dim)}
.pos .terms{margin-top:8px;font-size:13px;color:var(--dim);line-height:1.5;font-variant-numeric:tabular-nums}
.pos .terms b{color:var(--ink);font-weight:650}
.pos .lock{margin-top:4px;font-size:11.5px;color:var(--faint);line-height:1.45}
.pos .undo{color:var(--faint);font-size:11.5px;cursor:pointer;background:none;border:0;font:inherit;padding:2px 4px;opacity:.75}
.pos .undo:hover{text-decoration:underline;opacity:1}
.pos .f.end{justify-content:flex-end}
/* ---- parlays: the picks, their marks, and the lock that only exists at the last pick ---- */
.pos.parlay{padding:10px 12px 9px}
.parlay .pl b,.parlay .pl i{display:inline;font-size:14px}
.parlay .pl i{font-size:12px}
.picks{margin-top:7px;display:flex;flex-direction:column;gap:3px}
.pick{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--faint);line-height:1.35}
.pick i{font-style:normal;width:15px;height:15px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:9.5px;font-weight:800;flex-shrink:0;background:var(--card2);color:var(--faint);border:1px solid var(--line)}
.pick.hit i{background:var(--wash);color:var(--up);border-color:transparent}
.pick.miss i{background:rgba(255,107,107,.14);color:var(--down);border-color:transparent}
.pick span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pick span b{font-weight:600;color:var(--ink)}
.pick.miss span b{text-decoration:line-through;color:var(--dim)}
.pick em{font-style:normal;color:var(--faint);font-size:11.5px;white-space:nowrap;font-variant-numeric:tabular-nums}
.pick.hit em{color:var(--up)}
.pick.miss em{color:var(--down)}
.why{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:12.5px;color:var(--dim);text-align:left;cursor:pointer;flex:1;line-height:1.4}
.why:after{content:" \\203A";color:var(--faint)}
.note{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 4px 0;color:var(--faint);font-size:11.5px;line-height:1.4}
.info{appearance:none;width:18px;height:18px;border-radius:50%;border:1px solid var(--line);background:var(--card2);color:var(--dim);font:italic 700 11px Georgia,"Times New Roman",serif;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;padding:0}
.grp{display:flex;justify-content:space-between;align-items:center;margin:14px 4px 0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
.grp button{appearance:none;background:none;border:0;padding:0;font:inherit;font-size:11.5px;font-weight:600;letter-spacing:0;text-transform:none;color:var(--dim);cursor:pointer}
.pos.mini{padding:9px 12px;cursor:pointer}
.pos.mini .name{font-size:14px}
.pos.mini .meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pos.act{padding:9px 12px 8px}
.pos.act .name{font-size:14px}
.pos.act .meta{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pos.act .terms{margin-top:5px;font-size:12.5px}
.empty{padding:30px 16px;color:var(--faint);text-align:center;font-size:14px}
.host-note{position:fixed;left:0;right:0;bottom:0;padding:10px 16px 14px;text-align:center;color:var(--faint);font-size:11.5px;line-height:1.45;background:linear-gradient(to top,var(--bg) 70%,transparent);pointer-events:none}
/* deliberate lines (the disclaimer, the links, the credit): never a sentence that wraps and strands a link */
.host-note span,.host-note a,.host-note .pow,.host-note .links{display:block}
.host-note .links{display:flex;justify-content:center;gap:14px;margin-top:2px}
.host-note a{color:var(--dim);pointer-events:auto;white-space:nowrap;display:inline}
.host-note .pow{margin-top:4px;color:var(--faint)}
.host-note .pow b{color:var(--dim);font-weight:600}
.toast{position:fixed;left:50%;bottom:64px;transform:translate(-50%,8px);background:var(--ink);color:var(--bg);font-size:12.5px;font-weight:600;padding:8px 14px;border-radius:999px;opacity:0;pointer-events:none;transition:opacity .16s,transform .16s;white-space:nowrap;z-index:5}
.toast.on{opacity:.96;transform:translate(-50%,0)}
/* ---- the line and the panel: the extension's, in the host's colours ---- */
.ael-row{margin:10px 0 0}
.ael-line{display:flex;align-items:center;gap:10px;width:100%;appearance:none;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:12px;padding:8px 10px;font:inherit;cursor:pointer;text-align:left}
.ael-line:hover{border-color:var(--accent)}
.ael-line.ael-open{border-color:var(--accent);border-bottom-left-radius:0;border-bottom-right-radius:0}
.ael-tag{display:inline-flex;align-items:center;gap:5px;border:1.5px solid var(--accent);color:var(--accent);border-radius:999px;padding:3px 10px;font-size:12.5px;font-weight:700;white-space:nowrap;line-height:1.3}
.ael-tag .ael-ic{display:inline-flex;width:13px;height:13px}.ael-tag .ael-ic svg{width:13px;height:13px}
.ael-line-on .ael-tag{background:var(--accent);color:var(--accent-ink)}
.ael-line-off .ael-tag,.ael-line-wait .ael-tag{border-color:var(--line);color:var(--faint)}
.ael-line-flash .ael-tag{animation:aelflash 1.1s ease-out}
@keyframes aelflash{0%,40%{background:var(--accent);color:var(--accent-ink)}100%{background:var(--accent);color:var(--accent-ink)}}
.ael-fact{flex:1;min-width:0;font-size:14px;color:var(--ink);line-height:1.35}.ael-fact b{font-weight:650}
.ael-chev{flex:none;width:16px;height:16px;color:var(--faint);transition:transform .18s ease}.ael-chev svg{width:16px;height:16px;display:block}
.ael-open .ael-chev{transform:rotate(180deg)}
.ael-panel{border:1px solid var(--accent);border-top:0;border-radius:0 0 12px 12px;background:var(--card);padding:2px 12px 10px;animation:aelopen .16s ease-out}
@keyframes aelopen{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:none}}
.ael-wait{font-size:13px;color:var(--dim);padding:12px 0;line-height:1.4}
.ael-lr{display:flex;align-items:baseline;gap:14px;padding:9px 0;border-bottom:1px solid var(--line)}
.ael-lr.ael-last{border-bottom:0}
.ael-lr .ael-l{flex:1;min-width:0;font-size:14px;color:var(--ink)}
.ael-lr b{font-size:15px;font-weight:650;color:var(--ink);font-variant-numeric:tabular-nums;white-space:nowrap}
.ael-lr s{width:88px;font-size:12px;color:var(--faint);text-align:right;text-decoration:none;font-variant-numeric:tabular-nums;white-space:nowrap}
.ael-hero b{color:var(--up)}
.ael-acts{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:10px}
.ael-go{appearance:none;border:0;border-radius:999px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:700;font-size:14px;padding:9px 16px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;white-space:nowrap}
.ael-go .ael-ic{display:inline-flex;width:14px;height:14px}.ael-go .ael-ic svg{width:14px;height:14px}
.ael-go.ael-quiet{background:var(--card2);color:var(--ink);border:1px solid var(--line)}
.ael-go:disabled{opacity:.75;cursor:default}
.ael-stage{font-size:13px;color:var(--dim)}
.ael-tg{display:inline-flex;align-items:center;gap:3px;color:var(--dim);text-decoration:none;font-size:13px;font-weight:500;padding:6px 2px;white-space:nowrap}
.ael-tg:hover,.ael-tg[aria-expanded="true"]{color:var(--ink)}
.ael-tgc{display:inline-flex;width:14px;height:14px;transition:transform .18s ease}.ael-tgc svg{width:14px;height:14px;display:block}
.ael-tg[aria-expanded="true"] .ael-tgc{transform:rotate(180deg)}
.ael-fine{font-size:12px;color:var(--faint);margin:8px 0 0;line-height:1.4}
.ael-fine b{color:var(--dim);font-weight:600}
/* Details: rows in one grammar, a dim label and the value, the same two tones everywhere */
.ael-details{margin:10px 0 2px;padding-top:8px;border-top:1px solid var(--line)}
.ael-drows{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;row-gap:7px;align-items:baseline;font-size:12.5px;line-height:1.45;margin:0 0 8px}
.ael-dl{color:var(--faint);white-space:nowrap}
.ael-dv{color:var(--dim);min-width:0;overflow-wrap:anywhere}
.ael-dv b{font-weight:600;color:var(--ink)}
.ael-dim{color:var(--faint)}
.ael-dshape{align-self:center;margin-bottom:3px}
.ael-shape{display:inline-flex;border:1px solid var(--line);border-radius:8px;padding:2px;background:var(--card2);gap:2px;max-width:100%}
.ael-shape-b{appearance:none;border:1px solid transparent;border-radius:6px;background:transparent;color:var(--dim);font:inherit;font-size:12.5px;font-weight:500;line-height:1.2;padding:5px 10px;cursor:pointer;white-space:nowrap}
.ael-shape-b:hover{color:var(--ink)}
.ael-shape-b[aria-pressed="true"]{border-color:var(--accent);background:var(--wash);color:var(--ink);font-weight:600}
/* the receipt: the same rows on a quiet ground */
.ael-rcpt{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;row-gap:5px;font-size:12px;color:var(--dim);background:var(--wash);border-radius:10px;padding:8px 10px;margin:6px 0 4px;font-variant-numeric:tabular-nums;line-height:1.4}
.ael-rcpt>span{color:var(--faint)}
.ael-rcpt>b{font-weight:500;color:var(--dim);overflow-wrap:anywhere}
.ael-rcpt>b b{font-weight:600;color:var(--ink)}
.ael-rcpt code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
/* leave early: the live figures, two ways out, the reason behind a toggle */
.ael-leave{margin-top:10px;padding-top:8px;border-top:1px solid var(--line)}
.ael-leave-h{font-size:14px;font-weight:650;color:var(--ink)}
.ael-leave-h span{font-weight:400;color:var(--faint);font-size:12.5px;margin-left:6px}
.ael-leave .ael-lr .ael-l{font-size:13.5px}
.ael-leave .ael-pay{color:var(--ink)}
.ael-leave-acts{display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap}
.ael-leave-acts .ael-tg{margin-left:auto}
.ael-why{font-size:12.5px;color:var(--dim);line-height:1.5;margin-top:6px}
.ael-why p{margin:0 0 4px}
.ael-pow{display:flex;align-items:center;gap:6px;font-size:11.5px;color:var(--faint);margin-top:10px;padding-top:8px;border-top:1px solid var(--line)}
.ael-pow b{color:var(--dim);font-weight:600}
.ael-pow img{height:12px;display:block;opacity:.9}
/* ---- the venue view: the host's side of the same rows ---- */
.vnote{margin:10px 4px 2px;font-size:12.5px;color:var(--dim);line-height:1.5}
.vnote b{color:var(--ink);font-weight:600}
.vcard{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin:8px 0}
.vcard .h{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.vcard .name{font-weight:650;font-size:15px;line-height:1.25}
.vcard .meta{color:var(--faint);font-size:12px;margin-top:2px}
.vcard .vstate{font-size:12px;color:var(--dim);white-space:nowrap;text-align:right;font-variant-numeric:tabular-nums}
.vcard .vstate.on{color:var(--accent);font-weight:600}
.vrows{display:grid;grid-template-columns:max-content 1fr;column-gap:14px;row-gap:6px;margin-top:10px;padding-top:8px;border-top:1px solid var(--line);font-size:12.5px;line-height:1.45;font-variant-numeric:tabular-nums}
.vrows>span{color:var(--faint);white-space:nowrap}
.vrows>b{font-weight:500;color:var(--dim);overflow-wrap:anywhere}
.vrows>b b{font-weight:600;color:var(--ink)}
.vrows .vq{display:inline-flex;flex-wrap:wrap;gap:5px}
.vq i{font-style:normal;display:inline-flex;align-items:center;gap:4px;border:1px solid var(--line);border-radius:999px;padding:2px 8px;font-size:12px;color:var(--dim);white-space:nowrap}
.vq i b{color:var(--ink)}
.vq i.won{border-color:var(--accent);color:var(--ink);background:var(--wash)}
.vq i.host{border-style:solid}
.vq i.host:after{content:"yours";font-size:10.5px;color:var(--accent);font-weight:700;letter-spacing:.02em}
.vq i.mute{border-style:dashed;color:var(--faint)}
/* ---- the sheet: the parlays' and the notes' (the positions use the panel) ---- */
.scrim{position:fixed;inset:0;background:rgba(5,13,10,.5);opacity:0;pointer-events:none;transition:opacity .18s;z-index:8}
.scrim.on{opacity:1;pointer-events:auto}
.sheet{position:fixed;left:0;right:0;bottom:0;margin:0 auto;max-width:430px;background:var(--card);color:var(--ink);border-radius:18px 18px 0 0;padding:10px 16px calc(16px + env(safe-area-inset-bottom));transform:translateY(105%);transition:transform .22s cubic-bezier(.2,.8,.2,1);box-shadow:0 -12px 40px rgba(0,0,0,.18);z-index:9}
.sheet.on{transform:translateY(0)}
.sheet .grab{width:38px;height:4px;border-radius:2px;background:var(--line);margin:0 auto 12px}
.sheet h2{font-size:19px;font-weight:700;letter-spacing:-.01em;margin-top:8px;color:var(--ink)}
.sheet .who{color:var(--dim);font-size:13.5px;margin-top:2px}
.tiles{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-top:14px}
.tile{background:var(--card2);border-radius:12px;padding:10px 10px 9px;text-align:left}
.tile .l{color:var(--dim);font-size:11.5px}
.tile .v{font-weight:700;font-size:17px;margin-top:2px;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.tile .was{color:var(--faint);font-size:11px;margin-top:2px;font-variant-numeric:tabular-nums}
.tile.k .v{color:var(--up)}
.go{appearance:none;border:0;width:100%;margin-top:14px;border-radius:12px;padding:14px;background:var(--accent);color:var(--accent-ink);font:inherit;font-weight:700;font-size:16px;cursor:pointer;font-variant-numeric:tabular-nums}
.go:disabled{opacity:.55;cursor:default}
.go.quiet{background:var(--card2);color:var(--ink);border:1px solid var(--line)}
.sheet .fine{color:var(--faint);font-size:11.5px;text-align:center;margin-top:9px;line-height:1.45}
.sheet .fine a{color:var(--dim)}
.sheet .refusal{background:var(--card2);border-radius:12px;padding:14px;margin-top:14px;color:var(--ink);font-size:14.5px;line-height:1.5}
.sheet .refusal b{font-weight:700}
.sheet .how{display:none;margin-top:12px;color:var(--dim);font-size:13px;line-height:1.55}
.sheet .how.on{display:block}
.sheet .how p{margin:4px 0}
.sheet .done{text-align:center;padding:10px 0 2px}
.sheet .done .ck{width:52px;height:52px;border-radius:50%;background:var(--wash);color:var(--up);display:inline-flex;align-items:center;justify-content:center;font-size:26px;font-weight:700}
.sheet .done h2{margin-top:10px}
.sheet .done .sum{margin-top:6px;color:var(--dim);font-size:14px;font-variant-numeric:tabular-nums;line-height:1.55}
.sheet .done .sum b{color:var(--ink)}
.sheet .pow{display:flex;align-items:center;justify-content:center;gap:6px;margin-top:12px;font-size:11.5px;color:var(--faint)}
.sheet .pow img{height:12px;display:block}
/* ---- the desktop table shell: hidden until the stage is broad enough ---- */
.table{display:none}
/* ---- desktop: the pitch beside the mock; the sheet and scrim stay inside the phone ---- */
@media(min-width:900px){
  body{background:var(--stage);color:var(--stage-ink)}
  .stage{display:grid;grid-template-columns:minmax(300px,400px) minmax(400px,800px);gap:56px;align-items:start;justify-content:center;padding:40px 32px;min-height:100vh}
  .pitch{display:block;color:var(--stage-ink);position:sticky;top:40px}
  .pitch img{height:24px;display:block;margin-bottom:22px}
  .pitch h1{font-size:36px;line-height:1.1;letter-spacing:-.02em;font-weight:700}
  .pitch p{color:var(--stage-dim);font-size:16px;line-height:1.55;margin-top:14px;max-width:34em}
  .pitch ul{list-style:none;margin-top:18px;color:var(--stage-ink);font-size:15px;line-height:1.5}
  .pitch li{padding:6px 0 6px 22px;position:relative}
  .pitch li:before{content:"";position:absolute;left:0;top:13px;width:9px;height:9px;border-radius:50%;background:var(--ep-green)}
  .pitch li b{font-weight:650}
  .pitch .routed{margin-top:14px;font-size:13.5px;color:var(--stage-dim)}
  .pitch .try{margin-top:22px;color:var(--stage-ink);font-weight:600;font-size:15px}
  .pitch .try b{color:var(--ep-green)}
  .pitch .live{margin-top:26px;max-width:420px}
  .pitch .live-h{font-size:11px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--ep-green);margin-bottom:8px}
  .pitch .live video{display:block;width:100%;aspect-ratio:16/9;border-radius:10px;background:#0e0e10;box-shadow:0 14px 40px rgba(15,17,21,.18)}
  .pitch .live p{margin-top:10px;font-size:14px;line-height:1.5;color:var(--stage-ink)}
  .pitch .live p.live-fine{margin-top:4px;font-size:12px;color:var(--stage-dim)}
  .pitch .partners{margin-top:30px;padding-top:16px;border-top:1px solid rgba(15,17,21,.1);color:var(--stage-dim);font-size:12.5px}
  .pitch .partners b{color:var(--stage-ink);font-weight:600;margin-right:8px}
  .pitch .partners a{color:var(--stage-ink);text-decoration:none;border-bottom:1px solid rgba(15,17,21,.25);margin-right:12px}
  .pitch .partners a:hover{border-bottom-color:var(--stage-ink)}
  .pitch .foot{margin-top:14px;color:var(--stage-dim);font-size:12.5px}
  .demo{display:flex;flex-direction:column;align-items:center;gap:14px;color:var(--ink)}
  .ctl{padding:0}
  .seg.shellseg{display:inline-flex}
  .seg{background:#fff;border-color:rgba(15,17,21,.14)}
  .seg button{color:var(--stage-dim)}
  .seg button[aria-pressed="true"]{background:var(--stage-ink);color:#fff;border-color:var(--stage-ink)}
  .phone{margin:0;width:400px;height:min(820px,calc(100vh - 140px));min-height:560px;border-radius:40px;border:1px solid var(--frame);box-shadow:0 30px 80px rgba(15,17,21,.22),0 2px 6px rgba(15,17,21,.08);overflow:hidden;display:flex;flex-direction:column;color:var(--ink);background:var(--bg)}
  .demo.shell-table .phone{display:none}
  .host-top{padding-top:22px}
  .list{flex:1;min-height:0;overflow:auto;padding-bottom:84px}
  .host-note,.scrim,.sheet,.toast{position:absolute}
  .sheet{max-width:none;padding-bottom:22px}
  .stage.from-card .cardland{display:none}
  .stage.from-card .demo{display:flex}
  /* the desktop table: a venue's My Trades page, the line under each row as the recording shows it */
  .demo.shell-table .table{display:flex;flex-direction:column;width:100%;max-width:800px;height:min(820px,calc(100vh - 140px));min-height:560px;background:var(--bg);color:var(--ink);border:1px solid var(--frame);border-radius:14px;box-shadow:0 30px 80px rgba(15,17,21,.22),0 2px 6px rgba(15,17,21,.08);overflow:hidden;position:relative}
  .tbar{display:flex;align-items:center;gap:26px;padding:14px 20px;border-bottom:1px solid var(--line);background:var(--card)}
  .tbar nav{display:flex;gap:18px;font-size:13.5px;color:var(--faint);font-weight:600}
  .tbar nav span.on{color:var(--ink);border-bottom:2px solid var(--accent);padding-bottom:2px}
  .tbar .bal{margin-left:auto}
  .tbody{flex:1;min-height:0;overflow:auto;padding:6px 16px 70px}
  .thead,.trow{display:grid;grid-template-columns:minmax(0,2.2fr) 1fr 1fr 1fr 1.3fr;gap:12px;align-items:center}
  .thead{padding:10px 10px 8px;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
  .trow{padding:12px 10px 4px;font-size:14px;font-variant-numeric:tabular-nums}
  .trow .tname{font-weight:650}
  .trow .tname small{display:block;font-weight:400;color:var(--faint);font-size:12px;margin-top:2px}
  .trow .tmuted{color:var(--dim)}
  .tgrp{margin:12px 10px 0;font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--faint)}
  .tline{padding:0 10px 10px;border-bottom:1px solid var(--line)}
  .tline .ael-row{margin-top:6px}
  .table .host-note{position:absolute}
  .table .vcard{margin:8px 10px}
  .table .vnote{margin:10px 14px 2px}
}
</style>
</head>
<body>
<div class="stage${card ? " from-card" : ""}">
${cardBlock}<aside class="pitch">
  <img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" />
  <h1>One tap. Any prediction market.</h1>
  <p>One line under every open position. Your traders lock a floor and get paid today, on your page. We price the other side at every venue, buy it where it is cheapest, and share the spread with you.</p>
  <ul>
    <li><b>Every venue priced, every time.</b></li>
    <li><b>Your venue first when it is best,</b> never when it is not.</li>
    <li><b>The trader stays on your page.</b></li>
    <li><b>Plus a share of the spread:</b> a revenue line on hedges that used to leave your platform or never happen.</li>
  </ul>
  <div class="routed">Hedges mapped and routed through ParlayX where partnered.</div>
  <div class="try">Tap <b>Lock in</b> on any row, or switch to <b>Venue view</b> &rarr;</div>
  ${videoBlock}
  <div class="partners"><b>For partners</b><a href="${trackRecordUrl}">${recordLabel}</a><a href="/partner${brandQ}">Partner console</a>${opts.recordIsSlate ? "" : '<a href="/receipts">Receipts</a><a href="/board">Full board</a>'}</div>
  <div class="foot">Demo positions are simulated at live prices. The record also carries locks on real positions, hedged with real orders on Kalshi, Novig and ProphetX.</div>
</aside>
<div class="demo shell-phone" id="demo">
<div class="ctl">
  <div class="seg shellseg" role="group" aria-label="Shell"><button type="button" data-shell="phone" aria-pressed="true">Phone</button><button type="button" data-shell="table" aria-pressed="false">Desktop</button></div>
  <div class="seg viewseg" role="group" aria-label="View"><button type="button" data-view="trader" aria-pressed="true">Trader view</button><button type="button" data-view="venue" aria-pressed="false">Venue view</button></div>
</div>
<div class="phone" id="phone">
  <div class="host-top">
    <div class="brand"><i>${initial}</i>${brand}</div>
    <div class="bal"><i class="delta" id="delta" aria-hidden="true"></i><span id="bal" data-bal>Cash $412.50</span></div>
  </div>
  <div class="tabs"><span class="on" data-tab="Positions">Positions</span><span data-tab="Parlays">Parlays</span><span data-tab="Activity">Activity</span></div>
  <div class="list" id="list"><div class="empty" id="loading">loading your positions…</div></div>
  <div class="host-note"><span>Demo. Simulated positions at live prices; nothing is bought.</span><span class="links"><a href="${trackRecordUrl}">${recordLabel}</a><a href="#" data-reset="1">reset demo</a></span><span class="pow">Powered by <b>Atticus</b> &middot; routed via ParlayX</span></div>
  <div class="toast" id="toast" role="status" aria-live="polite"></div>
  <div class="scrim" id="scrim"></div>
  <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-h">
    <div class="grab"></div>
    <div id="sh-body"></div>
    <div class="pow">Powered by <img src="${ATTICUS_WORDMARK_GOLD_DATA_URI}" alt="Atticus" /></div>
  </div>
</div>
<div class="table" id="table">
  <div class="tbar"><div class="brand"><i>${initial}</i>${brand}</div><nav><span>Markets</span><span class="on">My Trades</span><span>Account</span></nav><div class="bal"><span data-bal>Cash $412.50</span></div></div>
  <div class="tbody" id="tbody"><div class="empty">loading your positions…</div></div>
  <div class="host-note"><span>Demo. Simulated positions at live prices; nothing is bought.</span><span class="links"><a href="${trackRecordUrl}">${recordLabel}</a><a href="#" data-reset="1">reset demo</a></span><span class="pow">Powered by <b>Atticus</b> &middot; routed via ParlayX</span></div>
</div>
</div>
</div>
<script>
(function(){
  'use strict';
  var S={rows:[],byTicker:{},R:{},cash:41250,tab:'Positions',shell:'phone',view:'trader',vv:null,vvErr:null,vvBusy:false,
    parlays:null,parlaysErr:null,byParlay:{},lockedBy:{},openParlay:null,showSettled:false,expanded:{},
    activity:null,activityErr:null,activityShown:25};
  /* the three shapes in the extension's order: the most upside first, the highest floor last */
  var TIER_ORDER=['wide','balanced','tight'];
  var TIER_WORDS={wide:'Max upside',balanced:'Balanced',tight:'Max floor'};
  var MIN_CREDIT_CENTS=${Math.round(minCredit.cents)},MIN_CREDIT_BPS=${Number(minCredit.bpsOfStake)};
  var SPORTS_ONLY=${sportsOnly ? "true" : "false"};
  var BRAND=${JSON.stringify(opts.brand)};
  var VV_URL='/api/venue-view'+${JSON.stringify(brandQ)};
  var SHIELD='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/></svg>';
  var SHIELD_FILL='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5l8 3v6.1c0 5.1-3.5 8.3-8 9.9-4.5-1.6-8-4.8-8-9.9V5.5l8-3zm-1.1 12.6l5-5-1.4-1.4-3.6 3.6-1.7-1.7-1.4 1.4 3.1 3.1z"/></svg>';
  var CHEVRON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
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
  /* CASH MOVES ON SCREEN: the credit is "paid now", so the number in the corner has to be seen
     taking it. Every change to cash goes through addCash: the balance updates at once, and a +$x
     (or -$x on a leave or a reset) sits beside it for under two seconds, then is gone. While a
     sheet is up the corner is behind the scrim, so the pulse waits for the sheet to close and
     fires then, when the eye is back on the list. */
  var deltaT=null,pendingDelta=0;
  function pulse(cents){
    var d=el('delta');d.textContent=(cents>0?'+':'-')+usd(Math.abs(cents));d.className='delta';void d.offsetWidth;d.className='delta on'+(cents<0?' down':'');
    clearTimeout(deltaT);deltaT=setTimeout(function(){d.className='delta'},1900);
  }
  function paintCash(){var bs=document.querySelectorAll('[data-bal]');for(var i=0;i<bs.length;i++)bs[i].textContent='Cash '+usd(S.cash)}
  function addCash(cents){
    if(!cents)return;
    S.cash+=cents;
    paintCash();
    if(S.openParlay){pendingDelta+=cents;return}
    pulse(cents);
  }
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
  function fmtNow(){try{return new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET'}catch(e){return 'now'}}
  function fmtAt(iso){try{var d=new Date(iso);return d.toLocaleDateString('en-US',{weekday:'short',timeZone:'America/New_York'})+' '+d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:'America/New_York'}).toLowerCase().replace(' ','')+' ET'}catch(e){return ''}}
  /* "tip-off" for a game on a court, "kickoff" on a field, "first pitch" on a diamond, "start" otherwise */
  function startWord(r){var l=String(r.league||'').toLowerCase();return r.kind==='crypto'?'settles':l==='nba'||l==='wnba'||l==='ncaab'?'tip-off':l==='nfl'||l==='ncaaf'||l==='epl'||l==='mls'?'kickoff':l==='mlb'?'first pitch':'start'}
  /* On a binary contract, floor F / cap C / credit K on n contracts is the same thing as keeping
     n*(C-F)/100 contracts and setting F*n + K aside in cash. The user only ever sees the two
     endings, floorTotal and capTotal, and the credit paid today; the rest is how it is built. */
  function reshape(n,F,C,K){return {kept:n*(C-F)/100, cashCents:Math.round(F*n)+K, floorTotal:Math.round(F*n)+K, capTotal:Math.round(C*n)+K}}
  /* the minimum-credit rule: 25¢ and 0.25% of stake, whichever is more */
  function worthIt(t,n){return !!t&&t.creditCents>=Math.max(MIN_CREDIT_CENTS,Math.round(n*100*MIN_CREDIT_BPS/10000))}
  /* REAL SIZES: the board quotes one showcase size; a positions list has a $10 pick beside a $100
     one. Each row takes a stake from the ticker (stable across repaints and reloads), its contracts
     are what that stake bought at the entry price, and every figure the quote carries is scaled to
     it. The hash also places the order a few hours or days back, as a venue would print it. */
  var STAKES=[1000,2500,5000,10000,2000,4000,7500,1500];
  function hash(s){var h=7;for(var i=0;i<s.length;i++)h=(h*31+s.charCodeAt(i))>>>0;return h}
  function sizeOf(r){
    var h=hash(r.kalshiTicker),stake=STAKES[h%STAKES.length],n=Math.round(stake/r.entryCents*100)/100;
    return {stakeCents:stake,contracts:n,payoutCents:Math.round(n*100),placedIso:new Date(Date.now()-(((h>>>4)%70)+2)*3600000).toISOString()};
  }
  /* a tier's terms at this row's size: the floor and the cap are per contract, the credit scales with the size */
  function scaled(t,q,n){var k=n/(q.contracts||n||1);return {floorCents:t.floorCents,capCents:t.capCents,creditCents:Math.round(t.creditCents*k)}}
  function offeredTiers(q,n){
    var out={},k,i;
    if(q.tiers){for(i=0;i<TIER_ORDER.length;i++){k=TIER_ORDER[i];if(q.tiers[k]){var s=scaled(q.tiers[k],q,n);if(worthIt(s,n))out[k]=s}}}
    else{var s1=scaled(q,q,n);if(worthIt(s1,n))out.balanced=s1}
    return out;
  }
  /* the shape the service heads the quote with, when it clears; else the first that does */
  function defaultTier(offered,q){if(q&&q.tier&&offered[q.tier])return q.tier;for(var i=0;i<TIER_ORDER.length;i++)if(offered[TIER_ORDER[i]])return TIER_ORDER[i];return null}
  function stateOf(t){return S.R[t]||(S.R[t]={open:false,q:null,busy:false,err:null,offered:{},tier:null,details:false,lock:null,rcpt:false,leave:null,removed:null,stage:'',flash:false})}
  function vvOf(t){if(!S.vv||!S.vv.rows)return null;for(var i=0;i<S.vv.rows.length;i++)if(S.vv.rows[i].kalshiTicker===t)return S.vv.rows[i];return null}
  function shortOf(r){return String(r.sideName||'').replace(/\\s+\\$.*$/,'')}

  /* POSITIONS, GROUPED: a flat list with Bitcoin strikes between NFL and NBA rows looks like no
     real app. Rows are grouped by league, the league with the nearest game first, crypto last;
     inside a group the rows keep the board's order. One league alone needs no header. */
  function groupRows(rows){
    var groups=[],by={},i,r,k,t;
    for(i=0;i<rows.length;i++){r=rows[i];k=r.kind==='crypto'?'crypto':String(r.league||'other').toLowerCase();t=Date.parse(r.eventTimeIso)||Infinity;
      if(!by[k]){by[k]={key:k,rows:[],next:t};groups.push(by[k])}by[k].rows.push(r);if(t<by[k].next)by[k].next=t}
    var out=[];for(i=0;i<groups.length;i++)if(groups[i].key!=='crypto')out.push(groups[i]);
    out.sort(function(a,b){return a.next-b.next});
    if(by.crypto)out.push(by.crypto);
    return out;
  }

  /* ---- THE LINE AND THE PANEL: the extension's block, rendered against the host's rows ---- */
  function lineGo(label,fact,cls,open){
    var muted=/ael-line-(off|wait)/.test(cls||'');
    return '<button type="button" class="ael-line '+(cls||'')+(open?' ael-open':'')+'" data-act="toggle"><span class="ael-tag">'+(muted?'':'<span class="ael-ic">'+SHIELD_FILL+'</span>')+'<b>'+label+'</b></span>'+(fact?'<span class="ael-fact">'+fact+'</span>':'')+'<span class="ael-chev">'+CHEVRON+'</span></button>';
  }
  function toggleA(act,label,open){return '<a href="#" class="ael-tg" data-act="'+act+'" aria-expanded="'+(open?'true':'false')+'">'+label+'<span class="ael-tgc">'+CHEVRON+'</span></a>'}
  function drow(label,value,cls){return '<span class="ael-dl'+(cls?' '+cls:'')+'">'+label+'</span><span class="ael-dv'+(cls?' '+cls:'')+'">'+value+'</span>'}
  function ledgerRow(label,value,was,cls){return '<div class="ael-lr'+(cls?' '+cls:'')+'"><span class="ael-l">'+label+'</span><b>'+value+'</b>'+(was===null?'':'<s>'+was+'</s>')+'</div>'}
  /* the slip: win, lose, cash now; the "of/instead of" column only while the position is unprotected */
  function ledger(r,rs,credit,was,locked){
    var name=esc(shortOf(r)),win=r.kind==='crypto'?'Settles yes':name+' win',lose=r.kind==='crypto'?'Settles no':name+' lose';
    return '<div class="ael-ledger">'+ledgerRow(win,usd(rs.capTotal),locked?null:'of '+usd(was))+ledgerRow(lose,usd(rs.floorTotal),locked?null:'instead of $0','ael-hero')+ledgerRow('Cash now','+'+usd(credit),locked?null:'','ael-last')+'</div>';
  }
  function shapeSegs(st,n,keys){
    var h='<div class="ael-shape" role="group" aria-label="Shape of the deal">';
    for(var i=0;i<keys.length;i++){var k=keys[i],tt=st.offered[k],tr=reshape(n,tt.floorCents,tt.capCents,tt.creditCents);
      h+='<button type="button" class="ael-shape-b" data-act="shape" data-tier="'+k+'" aria-pressed="'+(k===st.tier)+'" aria-label="'+esc(TIER_WORDS[k]+': win '+usd(tr.capTotal)+', lose '+usd(tr.floorTotal)+', '+usd(tt.creditCents)+' now')+'">'+TIER_WORDS[k]+'</button>'}
    return h+'</div>';
  }
  /* where the other side goes, in one sentence: the venue, the race, what the winner saved the trader; each venue's figure in the tooltip */
  function otherSide(v,n){
    if(!v||!v.hedgeVenue)return null;
    var k=n/(v.contracts||n||1),priced=[],muted=[],i;
    for(i=0;i<v.venues.length;i++)(v.venues[i].creditCents!=null?priced:muted).push(v.venues[i]);
    var parts=['<b>'+esc(v.hedgeVenue)+'</b>'+(v.hedgeVenue===S.vv.hostVenue?' <span class="ael-dim">(this venue)</span>':'')];
    if(priced.length>1){parts.push('best of '+priced.length+' venues');if(v.edgeCents>0)parts.push(usd(Math.round(v.edgeCents*k))+' more for you')}
    for(i=0;i<muted.length;i++)if(muted[i].host)parts.push('<span class="ael-dim">'+esc(muted[i].venue)+' '+esc(muted[i].why||'not offered')+'</span>');
    var tip=[];for(i=0;i<priced.length;i++)tip.push(priced[i].venue+' '+usd(Math.round(priced[i].creditCents*k)));for(i=0;i<muted.length;i++)tip.push(muted[i].venue+': '+(muted[i].why||'not offered'));
    return {html:parts.join(' &middot; '),tip:tip.join(' \\u00b7 '),shopped:priced.length>1};
  }
  /* Details behind the toggle, as rows in one grammar: Shape, Other side, Until, How; no figures in How, the figures are the slip */
  function detailRows(r,st,n,keys){
    var rows=[],o=otherSide(vvOf(r.kalshiTicker),n);
    if(keys.length>1)rows.push(drow('Shape',shapeSegs(st,n,keys),'ael-dshape'));
    if(o)rows.push(drow('Other side','<span'+(o.tip?' title="'+esc(o.tip)+'"':'')+'>'+o.html+'</span>'));
    else if(S.vvBusy)rows.push(drow('Other side','<span class="ael-dim">asking the venues&hellip;</span>'));
    rows.push(drow('Until',esc(startWord(r))+' '+esc(fmtEt(r.eventTimeIso))+' <span class="ael-dim">&middot; priced live</span>'));
    rows.push(drow('How','You sell part of the position today and keep the rest. The other side is bought the second you tap'+(o&&o.shopped?', at the best price across the venues that quoted it':'')+'; it settles on the same official result, nothing to manage.'));
    return '<div class="ael-details"><div class="ael-drows">'+rows.join('')+'</div></div>';
  }
  function powered(){return '<div class="ael-pow">Powered by <b>Atticus</b> &middot; routed via ParlayX where partnered</div>'}
  function removedLine(st){
    var m=st.removed;if(!m)return '';
    return '<div class="ael-fine">Earlier protection removed '+esc(m.at)+' &middot; '+(m.net<0?'you paid '+usd(-m.net):m.net>0?usd(m.net)+' paid to you':'nothing owed either way')+'.</div>';
  }
  /* the offer: the slip at the chosen shape, the pill, Details */
  function offerHtml(r,st){
    var n=sizeOf(r).contracts,t=st.offered[st.tier];
    if(!t)return '<div class="ael-wait">'+esc(st.err||'Protection isn\\'t available on this position right now.')+'</div>'+powered();
    var rs=reshape(n,t.floorCents,t.capCents,t.creditCents),keys=TIER_ORDER.filter(function(k){return !!st.offered[k]});
    var busy=!!st.stage;
    return ledger(r,rs,t.creditCents,Math.round(100*n),false)+
      '<div class="ael-acts">'+(busy?'<span class="ael-stage">'+esc(st.stage)+'</span>':'<button type="button" class="ael-go" data-act="go"><span class="ael-ic">'+SHIELD_FILL+'</span>Lock in</button>')+toggleA('details','Details',st.details)+'</div>'+
      removedLine(st)+
      (st.details?detailRows(r,st,n,keys):'')+powered();
  }
  /* the receipt: the same grammar, fewer rows; the other side priced at the venue's book, nothing bought in the demo */
  function receiptHtml(r,st){
    var L=st.lock,v=vvOf(r.kalshiTicker),k=L.contracts/((v&&v.contracts)||L.contracts||1),rows=[];
    var venue=v&&v.hedgeVenue?v.hedgeVenue:'the best venue',price=100-(r.markCents||50);
    var cmp='';
    if(v){var priced=v.venues.filter(function(x){return x.creditCents!=null});if(priced.length>1)cmp=' <span class="ael-dim">&middot; best of '+priced.length+' venues'+(v.edgeCents>0?', '+usd(Math.round(v.edgeCents*k))+' more for you':'')+'</span>'}
    rows.push('<span>Other side</span><b><b>'+esc(venue)+'</b> &middot; '+L.contracts+' contracts of the other side at '+price.toFixed(1)+'c'+cmp+' <span class="ael-dim">&middot; priced at the book; demo, nothing bought</span></b>');
    rows.push('<span>Cost</span><b>'+usd(v&&v.hedgeCostCents!=null?Math.round(v.hedgeCostCents*k):Math.round(L.contracts*price))+' <span class="ael-dim">all in</span></b>');
    rows.push('<span>Until</span><b>'+esc(startWord(r))+' '+esc(fmtEt(r.eventTimeIso))+' <span class="ael-dim">&middot; settles on the official result</span></b>');
    rows.push('<span>Paid to you</span><b>+'+usd(L.creditCents)+' <span class="ael-dim">&middot; paid '+esc(L.at)+'</span></b>');
    return '<div class="ael-rcpt">'+rows.join('')+'</div>';
  }
  /* the leave block: the live figures, the two ways out, the reason behind Why */
  function leaveHtml(r,st){
    var L=st.lock,lv=st.leave;
    var head='<div class="ael-leave"><div class="ael-leave-h">Leave early<span>remove the protection, keep your pick</span></div>';
    if(!lv.q&&!lv.err)return head+'<div class="ael-wait">Pricing your exit&hellip;</div></div>';
    if(!lv.q)return head+'<div class="ael-wait">'+esc(lv.err)+'</div><div class="ael-leave-acts"><button type="button" class="ael-go ael-quiet" data-act="stay">Back</button></div></div>';
    var net=lv.q.net,credit=L.creditCents,allIn=credit+net;
    var hero=net<0?'You pay <b class="ael-pay">'+usd(-net)+'</b>':net>0?'You get <b>'+usd(net)+'</b>':'Nothing owed either way';
    var netWords=allIn<0?'<b>\\u2212'+usd(-allIn)+'</b> after the '+usd(credit)+' paid to you at the lock':allIn>0?'<b>+'+usd(allIn)+'</b> ahead, with the '+usd(credit)+' paid to you at the lock':'even, with the '+usd(credit)+' paid to you at the lock';
    var why=(net<0?'Your pick moved up since the lock, so the upside you sold is worth more than the floor you hold; leaving settles that difference.':net>0?'Your pick moved down since the lock, so the floor you hold is worth more than the upside you sold; leaving pays you that difference.':'Your pick is where it was at the lock; the floor and the upside cancel.')+
      '</p><p>Your pick stays open on '+esc(BRAND)+', unprotected. The '+usd(credit)+' paid at the lock is yours either way.';
    return head+
      '<div class="ael-lr"><span class="ael-l">To leave now</span><b>'+hero+'</b></div>'+
      '<div class="ael-lr"><span class="ael-l">Net</span><b style="font-weight:400;font-size:13px">'+netWords+'</b></div>'+
      '<div class="ael-lr ael-last"><span class="ael-l">Staying</span><b>'+usd(L.floorTotal)+' or '+usd(L.capTotal)+'</b></div>'+
      '<div class="ael-leave-acts"><button type="button" class="ael-go" data-act="leavego">Leave early</button><button type="button" class="ael-go ael-quiet" data-act="stay">Stay</button>'+toggleA('why','Why',lv.why)+'</div>'+
      (lv.why?'<div class="ael-why"><p>'+why+'</p></div>':'')+
      '<div class="ael-fine">Priced live &middot; until '+esc(fmtEt(new Date(Date.parse(r.eventTimeIso)-45*60000).toISOString()))+'</div></div>';
  }
  /* the protected position: the slip with the locked numbers, Leave early and Details, the facts line, the receipt */
  function protectedHtml(r,st){
    var L=st.lock,rs={floorTotal:L.floorTotal,capTotal:L.capTotal};
    var v=vvOf(r.kalshiTicker),venue=v&&v.hedgeVenue?v.hedgeVenue:null;
    return ledger(r,rs,L.creditCents,0,true)+
      (st.leave?'':'<div class="ael-acts"><button type="button" class="ael-go ael-quiet" data-act="leave">Leave early</button>'+toggleA('rcpt','Details',st.rcpt)+'</div>')+
      (st.leave?leaveHtml(r,st):'<div class="ael-fine">Locked '+esc(L.at)+' &middot; the other side bought in '+L.secs+'s'+(venue?' on <b>'+esc(venue)+'</b>':'')+'</div>'+(st.rcpt?receiptHtml(r,st):''))+
      powered();
  }
  function lineHtml(r,st){
    var n=sizeOf(r).contracts;
    if(st.lock)return lineGo('Protected','<b>'+usd(st.lock.floorTotal)+'</b> or '+usd(st.lock.capTotal)+(vvOf(r.kalshiTicker)&&vvOf(r.kalshiTicker).hedgeVenue?' &middot; on '+esc(vvOf(r.kalshiTicker).hedgeVenue)+'.':'.'),'ael-line-on'+(st.flash?' ael-line-flash':''),st.open);
    if(st.q&&!st.offered[st.tier])return lineGo('Unavailable',esc(st.err||'The market can\\'t fund a worthwhile credit right now.'),'ael-line-off',st.open);
    var t=st.offered[st.tier];
    var floor=t?reshape(n,t.floorCents,t.capCents,t.creditCents).floorTotal:(function(){var k=n/(r.contracts||n||1);return Math.round(r.floorCents*n)+Math.round(r.creditCents*k)})();
    return lineGo('Lock in','Lose, and still get <b>'+usd(floor)+'</b>.','',st.open);
  }
  function panelHtml(r,st){
    if(st.lock)return protectedHtml(r,st);
    if(!st.q)return '<div class="ael-wait">Pricing from the live book&hellip;</div>';
    return offerHtml(r,st);
  }
  function rowBlockHtml(r){var st=stateOf(r.kalshiTicker);return '<div class="ael-row" data-row="'+esc(r.kalshiTicker)+'">'+lineHtml(r,st)+(st.open?'<div class="ael-panel">'+panelHtml(r,st)+'</div>':'')+'</div>'}
  function paintRow(t){
    /* both shells may hold the row; only the shown one is repainted */
    var r=S.byTicker[t],st=stateOf(t),host=(S.shell==='table'?el('tbody'):el('list')).querySelector('.ael-row[data-row="'+t.replace(/"/g,'')+'"]');
    if(!r||!host)return;
    host.innerHTML=lineHtml(r,st)+(st.open?'<div class="ael-panel">'+panelHtml(r,st)+'</div>':'');
    var pos=host.closest('.pos');if(pos)pos.className='pos has-line'+(st.lock?' protected':'');
  }
  /* the row's facts as a venue prints them */
  function factsHtml(r,z){return '<div class="facts"><span>Stake<b>'+usd(z.stakeCents)+'</b></span><span>Price<b>'+r.entryCents+'¢</b></span><span>Payout<b>'+usd(z.payoutCents)+'</b></span><span>Placed<b>'+esc(fmtAt(z.placedIso))+'</b></span></div>'}
  function paintPositions(){
    var into=S.shell==='table'?el('tbody'):el('list');
    if(!S.rows.length){into.innerHTML='<div class="empty">'+esc(S.err||'No open positions to lock in right now.')+'</div>';return}
    var html='',groups=groupRows(S.rows),g,gi,i,r,z,pl,when,st;
    if(S.shell==='table')html+='<div class="thead"><span>Position</span><span>Stake</span><span>Price</span><span>Payout</span><span>Placed</span></div>';
    for(gi=0;gi<groups.length;gi++){
      g=groups[gi];
      if(groups.length>1)html+=S.shell==='table'?'<div class="tgrp">'+esc(g.key.toUpperCase())+' &middot; '+g.rows.length+'</div>':'<div class="grp"><span>'+esc(g.key.toUpperCase())+' &middot; '+g.rows.length+'</span></div>';
      for(i=0;i<g.rows.length;i++){
        r=g.rows[i];z=sizeOf(r);st=stateOf(r.kalshiTicker);
        pl=Math.round((r.markCents-r.entryCents)*z.contracts);
        when=r.kind==='crypto'?'settles '+fmtEt(r.eventTimeIso):fmtEt(r.eventTimeIso);
        if(S.shell==='table'){
          html+='<div class="trow"><div class="tname">'+esc(r.sideName)+'<small>'+esc(r.league.toUpperCase())+' &middot; '+esc(when)+' &middot; <span class="'+(pl>0?'up':pl<0?'down':'')+'">'+(pl>=0?'+':'-')+usd(Math.abs(pl))+'</span> &middot; '+r.markCents+'¢ now</small></div>'+
            '<div>'+usd(z.stakeCents)+'</div><div class="tmuted">'+r.entryCents+'¢</div><div>'+usd(z.payoutCents)+'</div><div class="tmuted">'+esc(fmtAt(z.placedIso))+'</div></div>'+
            '<div class="tline">'+rowBlockHtml(r)+'</div>';
        }else{
          html+='<div class="pos has-line'+(st.lock?' protected':'')+'" data-ticker="'+esc(r.kalshiTicker)+'">'+
            '<div class="h"><div><div class="name">'+esc(r.sideName)+'</div><div class="meta">'+esc(r.league.toUpperCase())+' · '+esc(when)+'</div></div>'+
            '<div class="pl '+(pl>0?'up':pl<0?'down':'')+'"><b>'+(pl>=0?'+':'-')+usd(Math.abs(pl))+'</b><i>'+r.markCents+'¢ now</i></div></div>'+
            factsHtml(r,z)+rowBlockHtml(r)+'</div>';
        }
      }
    }
    into.innerHTML=html;
    paintCash();
  }

  /* ---- VENUE VIEW: the host's side of the same rows. What the trader never sees and the venue
     wants to: every venue asked for the other side, which one got it and by how much, what the
     hedge cost, and the spread with the host's share of it. Read from /api/venue-view, retail-safe. */
  function venueCardHtml(v){
    var r=S.byTicker[v.kalshiTicker]||{},z=r.kalshiTicker?sizeOf(r):{contracts:v.contracts,stakeCents:0},st=stateOf(v.kalshiTicker),k=z.contracts/(v.contracts||z.contracts||1),i;
    var chips='<span class="vq">';
    for(i=0;i<v.venues.length;i++){var x=v.venues[i];
      chips+=x.creditCents==null?'<i class="mute'+(x.host?' host':'')+'">'+esc(x.venue)+' &middot; '+esc(x.why||'not offered')+'</i>':'<i class="'+(x.chosen?'won':'')+(x.host?' host':'')+'">'+esc(x.venue)+' <b>'+usd(Math.round(x.creditCents*k))+'</b></i>'}
    chips+='</span>';
    var hostV=S.vv.hostVenue,won=v.hedgeVenue,why;
    var hostRow=null;for(i=0;i<v.venues.length;i++)if(v.venues[i].host)hostRow=v.venues[i];
    if(!won)why='no venue could fund the other side right now';
    else if(hostV&&won===hostV)why='<b>'+esc(won)+'</b>, your book: it paid the trader the most'+(v.edgeCents>0?', '+usd(Math.round(v.edgeCents*k))+' over the next venue':'')+'. The hedge stays with you.';
    else if(hostV&&hostRow&&hostRow.creditCents!=null)why='<b>'+esc(won)+'</b>: it paid the trader '+usd(Math.round(v.edgeCents*k))+' more than your book did for the same protection, so the other side went there. You take a share of the spread instead.';
    else if(hostV)why='<b>'+esc(won)+'</b>: your book '+esc(hostRow?hostRow.why||'did not price it':'did not price it')+' on this game, so the other side went to the best venue that did. You take a share of the spread.';
    else why='<b>'+esc(won)+'</b>: the best price of the venues that quoted it'+(v.edgeCents>0?', '+usd(Math.round(v.edgeCents*k))+' more for the trader':'')+'.';
    var state=st.lock?'<div class="vstate on">Locked by the trader &middot; '+esc(st.lock.at)+'</div>':'<div class="vstate">Offered &middot; +'+usd(Math.round(v.creditCents*k))+' to the trader</div>';
    var spread=Math.round(v.spreadCents*k),share=Math.round(v.hostShareCents*k);
    return '<div class="vcard"><div class="h"><div><div class="name">'+esc(v.sideName)+'</div><div class="meta">'+esc(String(v.league||'').toUpperCase())+' &middot; '+esc(fmtEt(v.eventTimeIso))+(z.stakeCents?' &middot; '+usd(z.stakeCents)+' at '+r.entryCents+'¢':'')+'</div></div>'+state+'</div>'+
      '<div class="vrows"><span>Quotes</span><b>'+chips+'</b>'+
      '<span>Other side</span><b>'+why+'</b>'+
      '<span>Hedge cost</span><b>'+(v.hedgeCostCents!=null?usd(Math.round(v.hedgeCostCents*k))+' <span class="ael-dim">all in, bought the second the trader taps</span>':'<span class="ael-dim">not priced</span>')+'</b>'+
      '<span>Spread</span><b>'+(spread>0?usd(spread)+' on this lock &middot; <b>your share '+usd(share)+'</b> <span class="ael-dim">('+S.vv.sharePct+'%)</span>':'<span class="ael-dim">waived on this lock</span>')+'</b></div></div>';
  }
  function paintVenue(){
    var into=S.shell==='table'?el('tbody'):el('list');
    var html='<div class="vnote"><b>What the trader does not see.</b> Every venue asked for the other side, which one got it and why, what the hedge cost, and your share of the spread. Your venue first when it is best, never when it is not.</div>';
    if(!S.vv){into.innerHTML=html+'<div class="empty">'+esc(S.vvErr||'asking the venues…')+'</div>';return}
    var rows=S.vv.rows||[];
    if(SPORTS_ONLY)rows=rows.filter(function(v){var r=S.byTicker[v.kalshiTicker];return !r||r.kind!=='crypto'});
    if(!rows.length){into.innerHTML=html+'<div class="empty">Nothing priced right now.</div>';return}
    for(var i=0;i<rows.length;i++)html+=venueCardHtml(rows[i]);
    into.innerHTML=html;
    paintCash();
  }
  function loadVenueView(){
    S.vvBusy=true;
    fetch(VV_URL,{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      S.vvBusy=false;
      if(!p||!p.ok){S.vv=null;S.vvErr=(p&&p.error)||'The venue view is unavailable right now.';if(S.view==='venue')paintList();return}
      S.vv=p;S.vvErr=null;
      if(S.view==='venue')paintList();else for(var t in S.R)if(Object.prototype.hasOwnProperty.call(S.R,t)&&S.R[t].open)paintRow(t);
    }).catch(function(){S.vvBusy=false;S.vv=null;S.vvErr='The venue view is unavailable right now.';if(S.view==='venue')paintList()});
  }

  function paintList(){
    if(S.shell!=='table'){
      if(S.tab==='Parlays'){paintParlays();return}
      if(S.tab==='Activity'){paintActivity();return}
    }
    if(S.view==='venue'){paintVenue();return}
    paintPositions();
  }

  /* ---- the taps on a row ---- */
  function openRow(t){
    var st=stateOf(t);
    st.open=!st.open;
    if(st.open&&!st.q&&!st.busy)loadQuote(t);
    if(st.open)track('row_tap',t);
    paintRow(t);
  }
  function loadQuote(t){
    var st=stateOf(t),r=S.byTicker[t];st.busy=true;
    fetch('/api/showcase?ticker='+encodeURIComponent(t),{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      st.busy=false;
      var q=p&&p.quote?p.quote:null;
      if(!q){st.q={ok:false};st.err=(p&&p.error)||'Live pricing is unavailable right now.';paintRow(t);return}
      st.q=q;
      if(q.ok){st.offered=offeredTiers(q,sizeOf(r).contracts);st.tier=defaultTier(st.offered,q);st.err=st.tier?null:'The market can\\'t fund a worthwhile credit on this one right now.'}
      else st.err=q.detail||'Protection isn\\'t available on this position right now.';
      paintRow(t);
    }).catch(function(){st.busy=false;st.q={ok:false};st.err='Live pricing is unavailable right now.';paintRow(t)});
  }
  /* the lock, in stages the pill reports in words; the record is the page's own */
  function lockIn(t){
    var st=stateOf(t),r=S.byTicker[t],tt=st.offered[st.tier];if(!tt||st.stage)return;
    var n=sizeOf(r).contracts,rs=reshape(n,tt.floorCents,tt.capCents,tt.creditCents),t0=Date.now();
    var stages=['Pricing from the live book\\u2026','Writing the record\\u2026','Buying the other side\\u2026'],i=0;
    st.stage=stages[0];paintRow(t);
    var step=setInterval(function(){
      i++;
      if(i<stages.length){st.stage=stages[i];paintRow(t);return}
      clearInterval(step);
      st.stage='';
      st.lock={tier:st.tier,floorCents:tt.floorCents,capCents:tt.capCents,creditCents:tt.creditCents,contracts:n,floorTotal:rs.floorTotal,capTotal:rs.capTotal,at:fmtNow(),secs:((Date.now()-t0)/1000).toFixed(1),
        sideName:r.sideName,league:r.league,eventTimeIso:r.eventTimeIso};
      st.details=false;st.flash=true;
      addCash(tt.creditCents);
      track('protect_on',t,st.tier);
      paintRow(t);
      setTimeout(function(){st.flash=false;paintRow(t)},1200);
    },700+Math.floor(Math.random()*400));
  }
  /* LEAVE EARLY: the protection alone is settled at the live books this second; the pick stays. */
  function leaveQuote(t){
    var st=stateOf(t),L=st.lock;if(!L||!st.leave)return;
    var r=S.byTicker[t],qc=st.q&&st.q.ok?st.q:null,n=L.contracts,base=qc?(qc.tiers&&qc.tiers[L.tier]?qc.tiers[L.tier]:qc):null;
    if(!base){st.leave.err='Live pricing is unavailable right now. Your terms stay locked.';paintRow(t);return}
    var qs='ticker='+encodeURIComponent(t)+'&floor='+L.floorCents+'&cap='+L.capCents+'&credit='+base.creditCents;
    track('close_quote',t,L.tier);
    fetch('/api/close-quote?'+qs,{cache:'no-store'}).then(function(x){return x.json()}).then(function(c){
      if(!st.leave)return;
      if(!c||!c.ok){st.leave.err=(c&&c.message)||'Live pricing is unavailable right now. Your terms stay locked.';paintRow(t);return}
      var k=n/(c.contracts||qc.contracts||n);
      st.leave.q={net:Math.round((c.leaveWithCents-c.withoutProtectionCents-base.creditCents)*k),at:Date.now()};
      paintRow(t);
    }).catch(function(){if(st.leave){st.leave.err='Live pricing is unavailable right now. Your terms stay locked.';paintRow(t)}});
  }
  function leaveGo(t){
    var st=stateOf(t),L=st.lock,lv=st.leave;if(!L||!lv||!lv.q)return;
    var net=lv.q.net;
    st.removed={at:fmtNow(),net:net};
    addCash(net);
    track('close_early',t,L.tier);
    st.lock=null;st.leave=null;st.rcpt=false;
    paintRow(t);
  }
  function resetDemo(){
    var t;for(t in S.R)if(Object.prototype.hasOwnProperty.call(S.R,t))delete S.R[t];
    for(t in S.lockedBy)if(Object.prototype.hasOwnProperty.call(S.lockedBy,t))delete S.lockedBy[t];
    addCash(41250-S.cash);
    track('protect_undo');
    paintList();
  }

  /* PARLAYS: the shadow's simulated tickets, read through /api/parlays in retail shape. Three states
     on a row. Two or more picks open: no lock, and the row says so (there is no market for the pair of
     games, so nothing to price it against). One pick open: the lock priced from the live book at the
     moment, or the reason it was refused, a tap away in full. Settled or busted: one line under a
     collapsed Settled group, the full comparison on tap. The lock tap here is simulated on top of the
     shadow's terms; nothing is re-priced in the browser. The parlays keep the sheet: a ticket has no
     row of its own in the venue's list to open under. */
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
  function lockIcon(){return SHIELD}
  /* a ticket still in play: the full card */
  function inPlayHtml(t){
    var L=t.lock,locked=!!S.lockedBy[t.id],head='',foot='';
    if(t.state==='open'){
      head='<b>'+t.picksOpen+' picks open</b>';
      foot='<div class="f end"><button class="pbtn off" disabled>Lock in opens at your last pick</button></div>';
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
    paintCash();
  }
  /* ACTIVITY: what finished. First this session's own taps (locks and early leaves made here,
     simulated, so a visitor finds what they just did where a real app would put it), then the
     record's finished positions through /api/activity in retail shape: settled at the venue's
     official result or closed early, most recent first. A row reads as what it ended at with
     the lock against what it would have ended at without; the credit paid at open is inside the
     first number and said. Nothing here is re-priced. */
  function fmtDay(iso){try{var d=new Date(iso);return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'America/New_York'}).replace(',','')}catch(e){return ''}}
  function sessionHtml(){
    var html='',k,r,p,t,L,st;
    for(k in S.R){if(!Object.prototype.hasOwnProperty.call(S.R,k))continue;st=S.R[k];r=S.byTicker[k]||{};p=st.lock;
      var name=(p&&p.sideName)||r.sideName||k,lg=String((p&&p.league)||r.league||'').toUpperCase(),when=(p&&p.eventTimeIso)||r.eventTimeIso;
      if(st.removed)html+='<div class="pos act"><div class="h"><div><div class="name">'+esc(name)+'</div><div class="meta">'+esc(lg)+' &middot; protection removed '+esc(st.removed.at)+'</div></div><div class="pl"><b>'+(st.removed.net<0?'you paid '+usd(-st.removed.net):st.removed.net>0?usd(st.removed.net)+' paid to you':'nothing owed')+'</b><i>the pick stays open</i></div></div></div>';
      else if(p)html+='<div class="pos act"><div class="h"><div><div class="name">'+esc(name)+'</div><div class="meta">'+esc(lg)+' &middot; locked in'+(when?' &middot; '+esc(fmtEt(when)):'')+'</div></div><div class="pl"><b>'+usd(p.floorTotal)+' or '+usd(p.capTotal)+'</b><i>'+usd(p.creditCents)+' paid now</i></div></div></div>';
    }
    for(k in S.lockedBy){if(!Object.prototype.hasOwnProperty.call(S.lockedBy,k))continue;t=S.lockedBy[k];L=t.lock;
      html+='<div class="pos act"><div class="h"><div><div class="name">'+t.size+'-pick parlay</div><div class="meta">'+t.leagues+' &middot; locked in</div></div><div class="pl"><b>'+usd(L.floorTotalCents)+' or '+usd(L.capTotalCents)+'</b><i>'+usd(L.creditCents)+' paid now</i></div></div></div>';
    }
    return html;
  }
  function activityRowHtml(a){
    var closed=a.state==='closed',won=a.outcome==='won';
    var meta=esc(String(a.league||'').toUpperCase())+' &middot; '+esc(fmtDay(a.atIso))+' &middot; '+(closed?'closed early':won?'won':'lost');
    var line=usd(a.creditCents)+' paid at open &middot; '+(closed?'closed before the result':won?'the win, to the cap':'the floor, paid');
    return '<div class="pos act"><div class="h"><div><div class="name">'+esc(a.name)+'</div><div class="meta">'+meta+'</div></div>'+
      '<div class="pl"><b>'+usd(a.endedCents)+'</b><i>vs '+usd0(a.withoutCents)+' without</i></div></div><div class="terms">'+line+'</div></div>';
  }
  function paintActivity(){
    var list=el('list'),A=S.activity,mine=sessionHtml(),i;
    var html='<div class="note"><span>Finished positions from our public record; nothing is bought.</span><button class="info" data-info="activity" aria-label="About this activity">i</button></div>';
    if(mine)html+='<div class="grp"><span>This session</span></div>'+mine;
    if(!A){list.innerHTML=html+'<div class="empty">'+esc(S.activityErr||'loading what finished…')+'</div>';return}
    var rows=A.rows||[],total=(A.settledCount||0)+(A.closedCount||0);
    if(SPORTS_ONLY)rows=rows.filter(function(r){return r.kind!=='crypto'});
    if(!rows.length){list.innerHTML=html+'<div class="empty">Nothing has finished yet.</div>';return}
    /* the feed carries the most recent rows; the record's full count is said when it is larger (a sportsbook shell hides crypto, so there the count is the rows') */
    html+='<div class="grp"><span>Finished &middot; '+(!SPORTS_ONLY&&total>rows.length?'last '+rows.length+' of '+total:rows.length)+'</span></div>';
    var n=Math.min(rows.length,S.activityShown);
    for(i=0;i<n;i++)html+=activityRowHtml(rows[i]);
    if(rows.length>n)html+='<div class="grp" style="justify-content:center"><button data-more="activity">Show '+Math.min(25,rows.length-n)+' more</button></div>';
    list.innerHTML=html;
    paintCash();
  }
  function loadActivity(){
    fetch('/api/activity',{cache:'no-store'}).then(function(x){return x.json()}).then(function(p){
      if(!p||!p.ok){S.activity=null;S.activityErr=(p&&p.error)||'Activity is unavailable right now.';if(S.tab==='Activity')paintList();return}
      S.activity=p;S.activityErr=null;
      if(S.tab==='Activity')paintList();
    }).catch(function(){S.activity=null;S.activityErr='Activity is unavailable right now.';if(S.tab==='Activity')paintList()});
  }
  function openActivityInfoSheet(){
    openPlainSheet('activity-info','<h2 id="sh-h">About this activity</h2>'+
      '<div class="how on"><p>Anything you lock in or leave here shows at the top for this session. It is simulated: nothing is bought.</p>'+
      '<p>Below that is our public record: positions we have been protecting on paper at live prices, settled at the venue\\'s official result or closed early. Each row says what it ended at with the lock and what the same position would have ended at without one. The amount paid at open is inside the first number.</p></div>');
  }
  function closeSheet(){S.openParlay=null;el('scrim').className='scrim';el('sheet').className='sheet';if(pendingDelta){var d=pendingDelta;pendingDelta=0;pulse(d)}}
  function openPlainSheet(key,body){
    S.openParlay=key;
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
  var sheetHow=false;
  function openParlaySheet(id){
    var t=S.byParlay[id];if(!t||!t.lock)return;
    var L=t.lock,last=t.picks[t.picks.length-1];
    S.openParlay=id;sheetHow=false;
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
    el('sh-how').onclick=function(e){e.preventDefault();sheetHow=!sheetHow;el('how').className='how'+(sheetHow?' on':'')};
    el('sh-go').onclick=function(){confirmParlayLock(t)};
  }
  function confirmParlayLock(t){
    var L=t.lock;
    S.lockedBy[t.id]={size:t.size,lock:L,leagues:leaguesOf(t)};addCash(L.creditCents);
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
    if(tab==='Activity'){track('activity_tab');if(!S.activity)loadActivity()}
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
  function setShell(shell){
    if(S.shell===shell)return;
    S.shell=shell;
    el('demo').className='demo shell-'+shell;
    var bs=document.querySelectorAll('[data-shell]');for(var i=0;i<bs.length;i++)bs[i].setAttribute('aria-pressed',String(bs[i].getAttribute('data-shell')===shell));
    track(shell==='table'?'shell_table':'shell_phone');
    paintList();
  }
  function setView(view){
    if(S.view===view)return;
    S.view=view;
    var bs=document.querySelectorAll('[data-view]');for(var i=0;i<bs.length;i++)bs[i].setAttribute('aria-pressed',String(bs[i].getAttribute('data-view')===view));
    if(view==='venue'){track('venue_view');if(!S.vv&&!S.vvBusy)loadVenueView()}
    paintList();
  }

  document.addEventListener('click',function(e){
    var a=e.target.closest?e.target.closest('[data-act]'):null;
    if(a){
      var row=a.closest('.ael-row'),t=row?row.getAttribute('data-row'):null,st=t?stateOf(t):null,act=a.getAttribute('data-act');
      if(!t)return;
      if(a.tagName==='A')e.preventDefault();
      e.stopPropagation();
      if(act==='toggle'){openRow(t);return}
      if(act==='details'){st.details=!st.details;paintRow(t);return}
      if(act==='shape'){st.tier=a.getAttribute('data-tier')||st.tier;track('tier_pick',t,st.tier);paintRow(t);return}
      if(act==='go'){lockIn(t);return}
      if(act==='rcpt'){st.rcpt=!st.rcpt;paintRow(t);return}
      if(act==='leave'){st.leave={q:null,err:null,why:false};paintRow(t);leaveQuote(t);return}
      if(act==='stay'){st.leave=null;paintRow(t);return}
      if(act==='why'){if(st.leave)st.leave.why=!st.leave.why;paintRow(t);return}
      if(act==='leavego'){leaveGo(t);return}
      return;
    }
    var b=e.target.closest?e.target.closest('[data-reset],[data-shell],[data-view],[data-tab],[data-parlay],[data-unlock],[data-info],[data-why],[data-settled],[data-expand],[data-more]'):null;
    if(!b)return;
    if(b.hasAttribute('data-reset')){e.preventDefault();resetDemo();return}
    var sh=b.getAttribute('data-shell');if(sh){setShell(sh);return}
    var vw=b.getAttribute('data-view');if(vw){setView(vw);return}
    if(b.hasAttribute('data-info')){if(b.getAttribute('data-info')==='activity')openActivityInfoSheet();else openInfoSheet();return}
    if(b.hasAttribute('data-more')){S.activityShown+=25;paintList();return}
    var why=b.getAttribute('data-why');
    if(why){openWhySheet(why);return}
    if(b.hasAttribute('data-settled')){S.showSettled=!S.showSettled;paintList();return}
    var ex=b.getAttribute('data-expand');
    if(ex){S.expanded[ex]=!S.expanded[ex];paintList();return}
    var pid=b.getAttribute('data-parlay');
    if(pid){openParlaySheet(pid);return}
    var ul=b.getAttribute('data-unlock');
    if(ul&&S.lockedBy[ul]){addCash(-S.lockedBy[ul].lock.creditCents);delete S.lockedBy[ul];paintList();return}
    var tab=b.getAttribute('data-tab');
    if(tab==='Positions'||tab==='Parlays'||tab==='Activity'){switchTab(tab);return}
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
  loadVenueView();
  /* ?tab=parlays or ?tab=activity opens on that tab; ?view=venue opens the host's side; ?shell=table opens the desktop table, so a link can land a partner there directly */
  try{
    if(/[?&]tab=parlays\\b/i.test(location.search))switchTab('Parlays');else if(/[?&]tab=activity\\b/i.test(location.search))switchTab('Activity');
    if(/[?&]shell=table\\b/i.test(location.search)&&window.matchMedia&&window.matchMedia('(min-width:900px)').matches)setShell('table');
    if(/[?&]view=venue\\b/i.test(location.search))setView('venue');
  }catch(e){}
  setInterval(function(){if(S.openParlay)return;for(var t in S.R)if(Object.prototype.hasOwnProperty.call(S.R,t)&&(S.R[t].open||S.R[t].lock))return;if(S.tab==='Parlays')loadParlays();else if(S.tab==='Activity')loadActivity();else{load();loadVenueView()}},60000);
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
  far_out_no_book: "too early: no venue has a real book yet",
  route_gated: "priced, but no venue can take the hedge tonight",
  mark_disagreement: "price unsettled: the odds have not settled yet",
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
    <div class="row"><span>Lock in taps (all pages)</span><b>${f.protects.total} <i>${f.protects.last7d} in 7 days</i></b></div>
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
      <li>A Lock in button on the position row; we supply the sheet</li>
    </ul>
  </div>
  <a class="cta" href="mailto:${email}?subject=${subject}">Talk to us</a>
  <div class="also">Or see the <a href="${escapeHtml(input.trackRecordUrl)}">track record</a> first: every quote, every settlement, our P&amp;L against the take we booked.</div>
  <div class="foot">Demonstration only. Simulated positions at live prices; nothing is bought.</div>
</div>
</body>
</html>`;
}
