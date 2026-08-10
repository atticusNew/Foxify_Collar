/**
 * Paper perp executor — a PerpLegExecutor that fills at the reference mid ± slippage without
 * touching any venue. Two jobs:
 *
 *   1. DRY RUNS of the principal-pair runner (both legs paper).
 *   2. STAND-IN SECOND VENUE while only one real adapter exists (e.g. real Hyperliquid long +
 *      paper short) — the hybrid is labeled honestly in every record via the venue name "paper".
 *
 * Mid source is injected (typically the REAL venue's mid, so paper fills track live prices).
 */

import type { PerpLegExecutor, PerpLegFill, OpenLegRequest, CloseLegRequest } from "./perpLegExecutor";

const DEFAULT_SLIPPAGE = 0.0005; // 5 bps simulated fill cost

export class PaperPerpExecutor implements PerpLegExecutor {
  readonly venue: string;
  private positions = new Map<string, number>(); // coin → signed size

  constructor(
    private readonly midSource: (coin: string) => Promise<number>,
    opts: { venueName?: string } = {}
  ) {
    this.venue = opts.venueName ?? "paper";
  }

  midPx(coin: string): Promise<number> {
    return this.midSource(coin);
  }

  async openLeg(req: OpenLegRequest): Promise<PerpLegFill> {
    const mid = await this.midSource(req.coin);
    const slip = req.slippagePct ?? DEFAULT_SLIPPAGE;
    const px = +(mid * (req.side === "long" ? 1 + slip : 1 - slip)).toFixed(2);
    const sz = +(req.notionalUsdc / mid).toFixed(8);
    if (!(sz > 0)) return { status: "error", requestedSz: 0, filledSz: 0, avgPx: null, message: "size rounds to 0" };
    this.positions.set(req.coin, (this.positions.get(req.coin) ?? 0) + (req.side === "long" ? sz : -sz));
    return { status: "filled", requestedSz: sz, filledSz: sz, avgPx: px, oid: `paper-${Date.now()}` };
  }

  async closeLeg(req: CloseLegRequest): Promise<PerpLegFill> {
    const mid = await this.midSource(req.coin);
    const slip = req.slippagePct ?? DEFAULT_SLIPPAGE;
    // Closing a long sells (worse = lower); closing a short buys back (worse = higher).
    const px = +(mid * (req.side === "long" ? 1 - slip : 1 + slip)).toFixed(2);
    const sz = +req.sz.toFixed(8);
    this.positions.set(req.coin, (this.positions.get(req.coin) ?? 0) + (req.side === "long" ? -sz : sz));
    return { status: "filled", requestedSz: sz, filledSz: sz, avgPx: px, oid: `paper-${Date.now()}` };
  }

  async positionSz(coin: string): Promise<number> {
    return this.positions.get(coin) ?? 0;
  }

  async fundingBpsPer8h(): Promise<number | null> {
    return null;
  }
}
