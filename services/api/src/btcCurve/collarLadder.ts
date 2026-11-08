/**
 * Lock in along the ladder: for every strike on the hourly ladder with a quotable mark, the
 * floor / cap / credit a holder would be offered, priced leg-for-leg off live listed option
 * books (the same pricer the public BTC demo uses). Holder-facing numbers only by default;
 * the writer's economics stay out of the payload unless the operator turns them on.
 */

import { quoteWrap } from "../eventCollar/eventCollarPricer";
import {
  bracketingPutStrikes,
  expiryToDate,
  getBtcOptionInstruments,
  getOptionBook,
  nearestExpiryAtOrAfter,
} from "../eventCollar/okxOptionsPublic";
import { DEFAULT_SEARCH_CONFIG, type WrapSearchConfig } from "../eventCollar/types";
import { bucketLabel } from "./analytics";
import type { Ladder } from "./types";

export interface CollarRow {
  bucketKey: string;
  label: string;
  strike: number;
  markCents: number;
  ok: boolean;
  floorCents?: number;
  capCents?: number;
  creditCents?: number;
  /** the holder's give-up on a win: 100 − cap, cents per contract */
  upsideGivenUpCents?: number;
  /** per-contract hedge legs cost, cents; writer-side, only with showTake */
  hedgeCostCents?: number;
  hedgeExpiry?: string;
  alignment?: string;
  takeCents?: number;
  refusal?: string;
}

export interface CollarLadder {
  at: string;
  ladderId: string;
  settlesAt: string;
  rows: CollarRow[];
  hedgeVenue: "okx";
  error?: string;
}

function searchConfig(indexPxUsd: number): WrapSearchConfig {
  const dynamicFee = Math.ceil(0.0006 * indexPxUsd);
  return {
    ...DEFAULT_SEARCH_CONFIG,
    takeBps: Number(process.env.EVENT_TAKE_BPS || DEFAULT_SEARCH_CONFIG.takeBps),
    feeCentsPerSpread: Number(process.env.EVENT_FEE_CENTS_PER_SPREAD || dynamicFee),
  };
}

export async function quoteCollarLadder(
  hourly: Ladder,
  spotUsd: number,
  now: Date,
  opts: { contracts?: number; showTake?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<CollarLadder> {
  const contracts = opts.contracts ?? 100;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const out: CollarLadder = { at: now.toISOString(), ladderId: hourly.id, settlesAt: hourly.settlesAt, rows: [], hedgeVenue: "okx" };
  let instruments: Awaited<ReturnType<typeof getBtcOptionInstruments>>;
  try {
    instruments = await getBtcOptionInstruments(fetchImpl);
  } catch (err) {
    out.error = `hedge venue unreachable from this machine (${(err as Error).message.slice(0, 80)})`;
    return out;
  }
  const resolutionTime = new Date(hourly.settlesAt);
  const expiry = nearestExpiryAtOrAfter(instruments, resolutionTime);
  const cfg = searchConfig(spotUsd);
  const candidates = hourly.buckets
    .filter((b) => b.kind === "above" && b.level !== undefined)
    .map((b) => {
      const q = hourly.quotes.find((x) => x.venue === "kalshi" && x.bucketKey === b.key);
      const mark = q && q.bidCents > 0 && q.askCents > 0 && q.askCents <= 99 ? Math.round((q.bidCents + q.askCents) / 2) : 0;
      return { b, mark };
    })
    .filter((c) => c.mark >= cfg.markLowerBoundCents && c.mark <= cfg.markUpperBoundCents);

  for (const { b, mark } of candidates) {
    const strike = b.level ?? 0;
    const row: CollarRow = { bucketKey: b.key, label: bucketLabel(b.key), strike, markCents: mark, ok: false };
    if (!expiry) {
      row.refusal = "no listed option expiry at or after the close";
      out.rows.push(row);
      continue;
    }
    const bracket = bracketingPutStrikes(instruments, expiry, strike);
    if (!bracket) {
      row.refusal = `no listed strikes bracket $${strike.toLocaleString("en-US")}`;
      out.rows.push(row);
      continue;
    }
    try {
      const [highPut, lowPut] = await Promise.all([getOptionBook(bracket.highInstId, fetchImpl), getOptionBook(bracket.lowInstId, fetchImpl)]);
      const quote = quoteWrap({
        marketTicker: b.key,
        markCents: mark,
        entryCents: mark,
        contracts,
        resolutionTime,
        now,
        indexPxUsd: spotUsd,
        vertical: { highPut, highStrike: bracket.highStrike, lowPut, lowStrike: bracket.lowStrike },
        hedgeExpiry: expiry,
        hedgeExpiryTime: expiryToDate(expiry),
        config: cfg,
      });
      if (quote.ok) {
        row.ok = true;
        row.floorCents = quote.floorCents;
        row.capCents = quote.capCents;
        row.creditCents = Math.round(quote.creditCents / contracts);
        row.upsideGivenUpCents = 100 - quote.capCents;
        row.hedgeExpiry = quote.hedgeExpiry;
        row.alignment = quote.alignment;
        if (opts.showTake) {
          row.takeCents = quote.takeCents;
          row.hedgeCostCents = Math.round((quote.legs.reduce((a, l) => a + (l.action === "buy" ? l.premiumCents : -l.premiumCents), 0) + quote.feesCents) / contracts);
        }
      } else {
        row.refusal = quote.detail;
      }
    } catch (err) {
      row.refusal = `option book unavailable (${(err as Error).message.slice(0, 60)})`;
    }
    out.rows.push(row);
  }
  return out;
}
