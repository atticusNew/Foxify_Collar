/**
 * Hyperliquid adapter for the venue-agnostic PerpLegExecutor.
 *
 * Opens/closes real perp legs as aggressive IOC limits (house pattern: never market orders,
 * closes always reduce-only). Sizing: notional / mid, rounded to the asset's szDecimals; price:
 * mid ± slippage, rounded to HL's perp price rule. Any unfilled remainder is reported honestly —
 * the caller (principal-mode runner) owns retry/abort policy, mirroring the OKX collar rails.
 */

import type { PerpLegExecutor, PerpLegFill, OpenLegRequest, CloseLegRequest } from "./perpLegExecutor";
import { HyperliquidClient, roundPx, roundSz } from "./hyperliquidClient";

const DEFAULT_SLIPPAGE = 0.005; // 50 bps aggressive-IOC distance

export class HyperliquidPerpExecutor implements PerpLegExecutor {
  readonly venue = "hyperliquid";
  constructor(private readonly client: HyperliquidClient) {}

  midPx(coin: string): Promise<number> {
    return this.client.midPx(coin);
  }

  positionSz(coin: string): Promise<number> {
    return this.client.positionSz(this.client.address(), coin);
  }

  fundingBpsPer8h(coin: string): Promise<number | null> {
    return this.client.fundingBpsPer8h(coin);
  }

  async openLeg(req: OpenLegRequest): Promise<PerpLegFill> {
    const meta = await this.client.assetMeta(req.coin);
    const mid = await this.client.midPx(req.coin);
    const slip = req.slippagePct ?? DEFAULT_SLIPPAGE;
    const isBuy = req.side === "long";
    const px = roundPx(mid * (isBuy ? 1 + slip : 1 - slip), meta.szDecimals);
    const sz = roundSz(req.notionalUsdc / mid, meta.szDecimals);
    const requestedSz = Number(sz);
    if (!(requestedSz > 0)) return { status: "error", requestedSz: 0, filledSz: 0, avgPx: null, message: `size rounds to 0 at $${req.notionalUsdc} notional` };
    const res = await this.client.placeOrder({ assetIndex: meta.assetIndex, isBuy, pxStr: px, szStr: sz, reduceOnly: false, tif: "Ioc" });
    return toFill(res, requestedSz);
  }

  async closeLeg(req: CloseLegRequest): Promise<PerpLegFill> {
    const meta = await this.client.assetMeta(req.coin);
    const mid = await this.client.midPx(req.coin);
    const slip = req.slippagePct ?? DEFAULT_SLIPPAGE;
    const isBuy = req.side === "short"; // closing a short buys back; closing a long sells
    const px = roundPx(mid * (isBuy ? 1 + slip : 1 - slip), meta.szDecimals);
    const sz = roundSz(req.sz, meta.szDecimals);
    const requestedSz = Number(sz);
    if (!(requestedSz > 0)) return { status: "error", requestedSz: 0, filledSz: 0, avgPx: null, message: "close size rounds to 0" };
    const res = await this.client.placeOrder({ assetIndex: meta.assetIndex, isBuy, pxStr: px, szStr: sz, reduceOnly: true, tif: "Ioc" });
    return toFill(res, requestedSz);
  }
}

const toFill = (res: Awaited<ReturnType<HyperliquidClient["placeOrder"]>>, requestedSz: number): PerpLegFill => {
  if (res.kind === "filled") {
    const status = res.totalSz >= requestedSz - 1e-12 ? "filled" : "partial";
    return { status, requestedSz, filledSz: res.totalSz, avgPx: res.avgPx, oid: res.oid };
  }
  if (res.kind === "resting") {
    // IOC should never rest; treat as unfilled and surface the oid for a defensive cancel.
    return { status: "unfilled", requestedSz, filledSz: 0, avgPx: null, oid: res.oid, message: "IOC unexpectedly resting" };
  }
  return { status: "error", requestedSz, filledSz: 0, avgPx: null, message: res.message };
};
