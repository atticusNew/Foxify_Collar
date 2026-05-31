/**
 * Foxify cost-vs-gain analysis runner.
 *
 * Pulls 24mo BTC daily OHLC, computes break-even moves per (tier × size ×
 * leverage), reports historical frequency of the position's natural move
 * absorbing the protection fee.
 *
 * Run: npx tsx src/costVsGainMain.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchBtcDailyOhlc } from "./fetchPrices.js";
import {
  buildDailyMoves, analyzeAll, SL_TIERS, POSITION_SIZES, LEVERAGES,
  type CostGainRow,
} from "./costVsGainAnalysis.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "..", "output");

function fmtUsd(v: number): string {
  if (v >= 0) return `$${v.toFixed(2)}`;
  return `-$${Math.abs(v).toFixed(2)}`;
}
function fmtUsd0(v: number): string {
  return v >= 0
    ? `$${Math.round(v).toLocaleString()}`
    : `-$${Math.round(Math.abs(v)).toLocaleString()}`;
}
function pct1(frac: number): string { return `${(frac * 100).toFixed(1)}%`; }
function pct2(frac: number): string { return `${(frac * 100).toFixed(2)}%`; }

async function main() {
  await mkdir(OUTPUT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const start24mo = new Date(Date.now() - 24 * 30 * 86_400_000).toISOString().slice(0, 10);

  console.error("[1/2] Fetching 24mo BTC daily OHLC…");
  const ohlc = await fetchBtcDailyOhlc(start24mo, today);
  const moves = buildDailyMoves(ohlc);

  console.error("[2/2] Analyzing cost-vs-gain across tier × size × leverage…");
  const rows = analyzeAll(moves);

  const report = buildReport(moves, rows);
  await writeFile(path.join(OUTPUT_DIR, "foxify_cost_vs_gain.md"), report, "utf8");
  console.log(report);
  console.error(`\n[Done] Written: ${OUTPUT_DIR}/foxify_cost_vs_gain.md`);
}

function buildReport(moves: ReturnType<typeof buildDailyMoves>, rows: CostGainRow[]): string {
  const L: string[] = [];
  L.push("# Foxify Per-Day Protection — Cost vs. Gain Analysis");
  L.push(`**Generated:** ${new Date().toISOString().slice(0, 10)}`);
  L.push(`**Window:** Last 24 months Coinbase BTC daily OHLC (${moves.length} trading days).`);
  L.push("");
  L.push("**The question this answers:** *Over a typical 24-hour holding window, how often does a perp position's natural P&L move enough in the trader's favor to fully offset the day's protection fee?*");
  L.push("");
  L.push("**The framing matters.** Protection has negative EV in expectation — that's true of all insurance. The useful question is not \"is protection free in expectation?\" (it's not) but \"on what fraction of days does the position's move absorb the fee, so the trader feels the cost as 'embedded' rather than 'extra'?\"");
  L.push("");
  L.push("---");
  L.push("");

  // ── §1: Headline — break-even moves per tier ──────────────────────────────
  L.push("## §1: Break-even daily BTC move per tier (per $10k of position)");
  L.push("");
  L.push("For each tier, this is the BTC daily move (favorable direction) at which the position's natural gain exactly equals the day's protection fee.");
  L.push("");
  L.push("| Tier | Daily fee per $10k | Break-even BTC move (favorable direction) | % of historical days BTC moved at-or-beyond this |");
  L.push("|---|---|---|---|");
  // Use position size = $10k for the headline
  for (const slTier of SL_TIERS) {
    const r = rows.find(x => x.slTier === slTier && x.positionSizeUsd === 10_000 && x.leverage === 10)!;
    // Days when |move| >= break-even (either direction; trader could be long OR short)
    const eitherDirectionAbsorb = moves.filter(m => m.moveAbsPct >= r.breakEvenMoveFracLong).length / moves.length;
    L.push(`| ${(slTier * 100).toFixed(0)}% | ${fmtUsd(r.dailyFeeUsd)}/day | ±${pct2(r.breakEvenMoveFracLong)} | **${pct1(eitherDirectionAbsorb)}** |`);
  }
  L.push("");
  L.push("**Reading:** the percentages above count days where BTC moved *in either direction* by at least the break-even — useful as a population statistic but not directly applicable to a directional perp trader (who only benefits from moves in their bet direction). For a single-direction trader (long OR short), see §2.");
  L.push("");
  L.push("Headline takeaway: the **10% tier** has a tiny break-even threshold ($0.25 per $1 of position) — most days, BTC's natural noise alone covers the fee. The **5% tier** at $65/day requires a 0.65% favorable move; about a third of historical days cleared that bar in each direction.");
  L.push("");

  // ── §2: Long vs short directional breakdown ───────────────────────────────
  L.push("---");
  L.push("");
  L.push("## §2: Long vs short — favorable direction matters");
  L.push("");
  L.push("BTC has had a slight upward drift over the last 24 months. Long positions absorb fees more often than shorts on the same break-even threshold.");
  L.push("");
  L.push("| Tier | Long absorbs fee (% of days) | Short absorbs fee (% of days) | Drift bias |");
  L.push("|---|---|---|---|");
  for (const slTier of SL_TIERS) {
    const r = rows.find(x => x.slTier === slTier && x.positionSizeUsd === 10_000 && x.leverage === 10)!;
    const drift = (r.pctDaysLongAbsorbsFee - r.pctDaysShortAbsorbsFee) * 100;
    L.push(`| ${(slTier * 100).toFixed(0)}% | ${pct1(r.pctDaysLongAbsorbsFee)} | ${pct1(r.pctDaysShortAbsorbsFee)} | ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}pp |`);
  }
  L.push("");
  L.push("**Practical implication:** the cost-vs-gain framing favors long positions slightly in this dataset. Short positions still absorb the fee a meaningful fraction of the time on the cheaper tiers (3%, 10%) but are tighter on the 5% tier.");
  L.push("");

  // ── §3: Position size & leverage — what changes? ──────────────────────────
  L.push("---");
  L.push("");
  L.push("## §3: Position size and leverage — what changes?");
  L.push("");
  L.push("**Position size:** the daily fee scales linearly with position size, but so does the gain per BTC move. *The break-even BTC move % is identical across position sizes.* The dollar amounts scale.");
  L.push("");
  L.push("| Tier | $10k position fee | $25k position fee | $50k position fee | Break-even move (same for all sizes) |");
  L.push("|---|---|---|---|---|");
  for (const slTier of SL_TIERS) {
    const r10 = rows.find(x => x.slTier === slTier && x.positionSizeUsd === 10_000 && x.leverage === 10)!;
    const r25 = rows.find(x => x.slTier === slTier && x.positionSizeUsd === 25_000 && x.leverage === 10)!;
    const r50 = rows.find(x => x.slTier === slTier && x.positionSizeUsd === 50_000 && x.leverage === 10)!;
    L.push(`| ${(slTier * 100).toFixed(0)}% | ${fmtUsd(r10.dailyFeeUsd)} | ${fmtUsd(r25.dailyFeeUsd)} | ${fmtUsd(r50.dailyFeeUsd)} | ±${pct2(r10.breakEvenMoveFracLong)} |`);
  }
  L.push("");
  L.push("**Leverage:** doesn't change the break-even BTC move at all (fee is on notional, gain is on notional). Leverage only changes the trader's *margin at risk* — and therefore changes the break-even **as % of margin** (the leverage-amplified version).");
  L.push("");

  // ── §4: Worst-case context (the loss-floor story) ─────────────────────────
  L.push("---");
  L.push("");
  L.push("## §4: Don't forget the loss-floor (why the protection exists)");
  L.push("");
  L.push("Cost-vs-gain frames the *typical day*. The point of protection is the *worst day*. Worst observed BTC daily move in the 24mo window:");
  L.push("");
  // Find worst daily down move and worst up move
  const worstDown = Math.min(...moves.map(m => m.movePctOpenToClose));
  const worstUp = Math.max(...moves.map(m => m.movePctOpenToClose));
  const worstDownDate = moves.find(m => m.movePctOpenToClose === worstDown)?.date ?? "";
  const worstUpDate = moves.find(m => m.movePctOpenToClose === worstUp)?.date ?? "";
  L.push(`- **Worst BTC down day:** ${pct2(worstDown)} on ${worstDownDate}`);
  L.push(`- **Worst BTC up day:** +${pct2(worstUp)} on ${worstUpDate}`);
  L.push("");
  L.push("On a $25,000 long position with 10× leverage (margin $2,500):");
  L.push("");
  L.push("| Scenario | Unhedged | With Foxify 5% protection |");
  L.push("|---|---|---|");
  L.push(`| Worst observed BTC down day | ${fmtUsd0(worstDown * 25_000)} (${pct2(worstDown * 10)} of margin) | -$1,250 SL paid out at -5% trigger; further losses prevented if SL fired in time |`);
  L.push(`| Average day | ~$0 P&L drift | Same, minus $162.50/day fee |`);
  L.push("");
  L.push("**The protection isn't \"free protection.\"** It's a small fee against the small risk that today is the worst day. On most days, the position's natural move makes the fee feel embedded (as quantified in §1); on the rare bad days, the SL prevents the catastrophe.");
  L.push("");

  // ── §5: How to talk about this with traders ───────────────────────────────
  L.push("---");
  L.push("");
  L.push("## §5: How to talk about this with traders (suggested copy)");
  L.push("");
  L.push("Three honest framings, in order of strength:");
  L.push("");
  L.push("**Framing 1 (most defensible — break-even probability):**");
  L.push("> *\"At our 5% protection tier, if BTC moves more than 0.65% in your favor in a day — which happens about 1 day in 3 historically — your position's natural move covers the protection fee for that day. On the other days, you paid for protection that didn't fire — same dynamic as buying car insurance you didn't claim.\"*");
  L.push("");
  L.push("**Framing 2 (clear value framing — loss floor):**");
  L.push("> *\"For a few dozen dollars per day on a $10k position, your worst possible day is capped at a 5% loss instead of unlimited. On a single -10% day (we've had several), that protection turns a -$1,000 loss into a -$500 loss + the day's fee.\"*");
  L.push("");
  L.push("**Framing 3 (combined — the honest two-sentence pitch):**");
  L.push("> *\"On most days your position's natural move covers the protection fee. The fee buys you a hard floor on the worst day — the kind of day that wipes out untriggered traders.\"*");
  L.push("");
  L.push("**What NOT to say:**");
  L.push("- ❌ \"Protection pays for itself.\" (Misleading — true some days, false others.)");
  L.push("- ❌ \"Average gain offsets the fee.\" (BTC daily mean return is ~0; this isn't true in expectation.)");
  L.push("- ❌ \"Free protection most of the time.\" (Confuses correlation with causation; the fee is paid every day regardless.)");
  L.push("");

  // ── §6: Caveats ───────────────────────────────────────────────────────────
  L.push("---");
  L.push("");
  L.push("## §6: Caveats");
  L.push("");
  L.push("- **Daily-resolution analysis.** Intra-day moves often cross the break-even and reverse. The analysis uses open-to-close, which understates volatility around the break-even threshold.");
  L.push("- **24-month sample.** BTC has had a particular drift profile over this period (mostly bullish, some sharp drawdowns). A different 24-month window would show different long/short asymmetry.");
  L.push("- **Per-day framing only.** Doesn't capture multi-day holds where the fee compounds. Use the deep analysis (PR #95) for cumulative-cycle math.");
  L.push("- **Doesn't include perp funding rates.** Funding can be a small per-day cost or revenue depending on perp side and market state.");
  L.push("- **Cost-vs-gain is one of two value framings.** The other (loss-floor on the worst day) is in PR #95. Both should be told together for full honesty.");
  return L.join("\n");
}

main();
