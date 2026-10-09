/**
 * "N of your listings, priced": quote hand-entered marketplace listings against
 * live venue books and write the one-pager.
 *
 *   npx tsx scripts/wagerwireListingsQuote.ts [--listings <path>] [--out <dir>] [--marketplace <name>]
 *
 * Reads the listings JSON (a person's reading of the marketplace's public
 * pages; see src/eventCollar/crossVenue/listingQuote.ts for why nothing is read
 * by machine), looks up each remaining leg on Polymarket's public Gamma and
 * CLOB APIs, quotes the lock with carry to resolution, and writes:
 *
 *   <out>/listings-quoted-<date>.json   every row, every cent
 *   <out>/atticus_wagerwire_listings.md  the one-pager (build the PDF with scripts/md_to_pdf.py)
 *
 * Read-only: public market data, nothing bought. Env: EVENT_LISTING_CARRY_BPS_PER_MONTH
 * (default 50), EVENT_X_MIN_CREDIT_CENTS / EVENT_X_MIN_CREDIT_BPS (the live minimum-credit rule).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ListingMarketState,
  type ListingQuoteRow,
  fmtUsd,
  listingConfigFromEnv,
  listingsMarkdown,
  parseListings,
  quoteListing,
  refuseListing,
} from "../src/eventCollar/crossVenue/listingQuote";
import { getEventMarketsBySlug, getPmBook } from "../src/eventCollar/crossVenue/polymarketPublic";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..", "..");
const DEFAULT_DIR = join(REPO_ROOT, "docs", "reports", "submission", "wagerwire");

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** The remaining leg's live state on Polymarket: the side's price and the opposing book. */
export async function readPolymarketLeg(eventSlug: string, outcome: string, side: 0 | 1): Promise<ListingMarketState> {
  const markets = await getEventMarketsBySlug(eventSlug);
  const needle = outcome.toLowerCase();
  const m = markets.find((x) => x.question.toLowerCase().includes(needle));
  if (!m) throw new Error(`no market in ${eventSlug} names "${outcome}"`);
  if (m.tokenIds.length < 2 || m.outcomePricesMilli.length < 2) throw new Error(`${m.question}: not a two-outcome market`);
  const sidePriceMilli = m.outcomePricesMilli[side];
  const noBook = await getPmBook(m.tokenIds[1 - side]);
  return {
    markCents: Math.round(sidePriceMilli / 10),
    markMilli: sidePriceMilli,
    noBook,
    noOutcome: m.outcomes[1 - side] ?? "No",
    closed: m.closed || !m.acceptingOrders,
    eventTitle: m.eventTitle,
    question: m.question,
  };
}

async function main(): Promise<void> {
  const listingsPath = arg("listings", join(DEFAULT_DIR, "listings.json"));
  const outDir = arg("out", DEFAULT_DIR);
  const marketplace = arg("marketplace", "WagerWire");
  const cfg = listingConfigFromEnv(process.env);
  const listings = parseListings(JSON.parse(readFileSync(listingsPath, "utf8")));
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const rows: ListingQuoteRow[] = [];
  for (const l of listings) {
    if (l.legsRemaining !== 1) {
      rows.push(quoteListing(l, { markCents: 0, markMilli: 0, noBook: { tokenId: "", asks: [], bids: [], minOrderSizeShares: 5, tickMilli: 10 }, noOutcome: "", closed: false, eventTitle: "", question: "" }, nowMs, cfg));
      continue;
    }
    const leg = l.remaining[0];
    try {
      const state = await readPolymarketLeg(leg.eventSlug as string, leg.outcome as string, leg.side);
      rows.push(quoteListing(l, state, nowMs, cfg));
    } catch (err) {
      rows.push(refuseListing(l, nowIso, "no_matched_market", String(err instanceof Error ? err.message : err)));
    }
  }

  mkdirSync(outDir, { recursive: true });
  const day = nowIso.slice(0, 10);
  const jsonPath = join(outDir, `listings-quoted-${day}.json`);
  writeFileSync(jsonPath, `${JSON.stringify({ at: nowIso, marketplace, carryBpsPerMonth: cfg.carryBpsPerMonth, minimumCredit: cfg.minimum, rows }, null, 2)}\n`, "utf8");
  const mdPath = join(outDir, "atticus_wagerwire_listings.md");
  writeFileSync(mdPath, listingsMarkdown(rows, nowIso, { marketplace, hedgeVenues: ["Polymarket"], contact: "Michael Ting, michael@atticustrade.com." }), "utf8");

  for (const r of rows) {
    const leg = r.remaining.map((x) => x.label).join(" + ");
    const fair = r.fairCents === null ? "n/a" : fmtUsd(r.fairCents);
    if (r.quote.ok) {
      const q = r.quote;
      console.log(`${r.id}  ${r.book} ${r.legsTotal}-leg  ${leg}  mark ${r.markCents}c  ask ${fmtUsd(r.askCents)}  fair ${fair}  lock ${fmtUsd(q.lockWorstCents)} / ${fmtUsd(q.lockBestCents)}  credit ${fmtUsd(q.creditCents)}  carry ${fmtUsd(q.carryCents)} (${q.monthsCarried}m)  take ${fmtUsd(q.takeCents)}${r.lockBeatsAsk ? "  BEATS ASK" : ""}`);
    } else {
      console.log(`${r.id}  ${r.book} ${r.legsTotal}-leg  ${leg}  mark ${r.markCents ?? "-"}c  ask ${fmtUsd(r.askCents)}  fair ${fair}  refused ${r.quote.code}: ${r.quote.detail}`);
    }
  }
  const quoted = rows.filter((r) => r.quote.ok).length;
  console.log(`\n${quoted}/${rows.length} quoted · ${rows.filter((r) => r.lockBeatsAsk).length} locks beat the ask · wrote ${jsonPath} and ${mdPath}`);
  console.log(`PDF: python3 -c "import sys; sys.path.insert(0,'scripts'); from md_to_pdf import convert; convert('${mdPath.replace(`${REPO_ROOT}/`, "")}','${mdPath.replace(`${REPO_ROOT}/`, "").replace(/\.md$/, ".pdf")}')"  (from the repo root)`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
