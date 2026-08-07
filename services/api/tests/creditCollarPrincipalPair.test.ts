import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PerpLegExecutor, PerpLegFill, OpenLegRequest, CloseLegRequest } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/perpLegExecutor";
import { PaperPerpExecutor } from "../src/singleSide/twoSided/creditCollar/execution/perpVenues/paperPerpExecutor";
import { runPrincipalPairCycle, closePrincipalPair, loadPrincipalPairs } from "../src/singleSide/twoSided/creditCollar/execution/principalPairRunner";

const freshPath = () => join(mkdtempSync(join(tmpdir(), "principal-")), "pairs.jsonl");
const MID = 64_000;

/** Scriptable fake venue: per-call behaviors for open/close. */
class FakeVenue implements PerpLegExecutor {
  openCalls: OpenLegRequest[] = [];
  closeCalls: CloseLegRequest[] = [];
  constructor(
    readonly venue: string,
    private script: { open?: Array<Partial<PerpLegFill>>; close?: Array<Partial<PerpLegFill>> } = {}
  ) {}
  async midPx(): Promise<number> {
    return MID;
  }
  async openLeg(req: OpenLegRequest): Promise<PerpLegFill> {
    this.openCalls.push(req);
    const base: PerpLegFill = { status: "filled", requestedSz: req.notionalUsdc / MID, filledSz: req.notionalUsdc / MID, avgPx: MID, oid: 1 };
    return { ...base, ...(this.script.open?.shift() ?? {}) };
  }
  async closeLeg(req: CloseLegRequest): Promise<PerpLegFill> {
    this.closeCalls.push(req);
    const base: PerpLegFill = { status: "filled", requestedSz: req.sz, filledSz: req.sz, avgPx: MID, oid: 2 };
    return { ...base, ...(this.script.close?.shift() ?? {}) };
  }
  async positionSz(): Promise<number> {
    return 0;
  }
  async fundingBpsPer8h(): Promise<number | null> {
    return null;
  }
}

const cfg = (pairsPath: string, over: Record<string, unknown> = {}) => ({
  coin: "BTC",
  notionalUsdcPerLeg: 1_000,
  pairsPath,
  nowMs: () => 1_800_000_000_000,
  ...over
});

test("happy path: both legs fill cross-venue, record is open and size-matched", async () => {
  const path = freshPath();
  const a = new FakeVenue("hyperliquid");
  const b = new FakeVenue("paper2");
  const res = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(res.action, "opened");
  const rec = loadPrincipalPairs(path)[0];
  assert.equal(rec.status, "open");
  assert.equal(rec.long?.venue, "hyperliquid");
  assert.equal(rec.short?.venue, "paper2");
  assert.equal(rec.long?.sz, rec.short?.sz, "legs size-matched");
  assert.equal(b.openCalls[0].side, "short");
});

test("self-match is REFUSED in code: same venue name on both legs never opens", async () => {
  const path = freshPath();
  const res = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("hyperliquid"), cfg(path));
  assert.equal(res.action, "skipped");
  assert.match((res as { reason: string }).reason, /SELF-MATCH REFUSED/);
  assert.equal(loadPrincipalPairs(path).length, 0);
});

test("pair-atomic: short fails ⟹ long is abort-closed reduce-only, record aborted", async () => {
  const path = freshPath();
  const a = new FakeVenue("hyperliquid");
  const b = new FakeVenue("paper2", { open: [{ status: "error", filledSz: 0, message: "insufficient margin" }] });
  const res = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(res.action, "aborted");
  assert.equal(a.closeCalls.length, 1, "long was abort-closed");
  assert.equal(a.closeCalls[0].side, "long");
  assert.equal(loadPrincipalPairs(path)[0].status, "aborted");
});

test("naked-leg CRITICAL: short fails AND abort-close fails ⟹ flagged, and further opens are BLOCKED", async () => {
  const path = freshPath();
  const a = new FakeVenue("hyperliquid", { close: [{ status: "unfilled", filledSz: 0 }] });
  const b = new FakeVenue("paper2", { open: [{ status: "error", filledSz: 0 }] });
  const res = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(res.action, "critical_naked_leg");
  assert.match(loadPrincipalPairs(path)[0].abortReason ?? "", /NAKED/);

  // Next cycle must refuse to open while the critical record is unresolved.
  const res2 = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(path, { nowMs: () => 1_800_000_100_000 }));
  assert.equal(res2.action, "skipped");
  assert.match((res2 as { reason: string }).reason, /BLOCKED/);
});

test("partial short fill ⟹ long excess is trimmed to match", async () => {
  const path = freshPath();
  const fullSz = 1_000 / MID;
  const a = new FakeVenue("hyperliquid");
  const b = new FakeVenue("paper2", { open: [{ status: "partial", filledSz: fullSz / 2 }] });
  const res = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(res.action, "opened");
  assert.equal(a.closeCalls.length, 1, "excess long trimmed");
  assert.ok(Math.abs(a.closeCalls[0].sz - fullSz / 2) < 1e-9);
  const rec = loadPrincipalPairs(path)[0];
  assert.equal(rec.long?.sz, rec.short?.sz);
});

test("short overfill (price drift) ⟹ SHORT excess is trimmed — delta-neutral means equal base size", async () => {
  const path = freshPath();
  const fullSz = 1_000 / MID;
  const a = new FakeVenue("hyperliquid");
  // Short fills 1% larger than the long (legs priced at slightly different mids)
  const b = new FakeVenue("paper2", { open: [{ status: "filled", filledSz: fullSz * 1.01 }] });
  const res = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(res.action, "opened");
  assert.equal(b.closeCalls.length, 1, "excess SHORT trimmed on the short venue");
  assert.equal(b.closeCalls[0].side, "short");
  const rec = loadPrincipalPairs(path)[0];
  assert.equal(rec.long?.sz, rec.short?.sz, "zero residual delta after trim");
});

test("daily quota: second pair same UTC day is skipped; hard notional cap refuses oversized legs", async () => {
  const path = freshPath();
  await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(path));
  const res2 = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(path, { nowMs: () => 1_800_000_000_001 }));
  assert.equal(res2.action, "skipped");
  assert.match((res2 as { reason: string }).reason, /quota/);

  const res3 = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(freshPath(), { notionalUsdcPerLeg: 100_000 }));
  assert.equal(res3.action, "skipped");
  assert.match((res3 as { reason: string }).reason, /hard cap/);
});

test("close: both legs reduce, record closed; wrong executors refused; incomplete close flags critical", async () => {
  const path = freshPath();
  const a = new FakeVenue("hyperliquid");
  const b = new FakeVenue("paper2");
  const opened = await runPrincipalPairCycle(a, b, cfg(path));
  assert.equal(opened.action, "opened");
  const ref = (opened as { record: { ref: string } }).record.ref;

  // Wrong venue mapping refused
  const wrong = await closePrincipalPair(ref, new FakeVenue("okx_perp"), b, { coin: "BTC", pairsPath: path });
  assert.equal(wrong?.status, "open");
  assert.match(wrong?.notes.join(" ") ?? "", /CLOSE REFUSED/);

  const closed = await closePrincipalPair(ref, a, b, { coin: "BTC", pairsPath: path, nowMs: () => 1_800_000_200_000 });
  assert.equal(closed?.status, "closed");
  assert.equal(a.closeCalls.at(-1)?.side, "long");
  assert.equal(b.closeCalls.at(-1)?.side, "short");

  // Incomplete close on a fresh pair flags critical
  const path2 = freshPath();
  const a2 = new FakeVenue("hyperliquid", { close: [{ status: "unfilled", filledSz: 0 }] });
  const b2 = new FakeVenue("paper2");
  const o2 = await runPrincipalPairCycle(a2, b2, cfg(path2));
  const c2 = await closePrincipalPair((o2 as { record: { ref: string } }).record.ref, a2, b2, { coin: "BTC", pairsPath: path2 });
  assert.equal(c2?.status, "naked_leg_critical");
});

test("wrap hook runs after both fills; wrap failure is recorded, pair still opens", async () => {
  const path = freshPath();
  let wrapped = 0;
  const ok = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(path, {
    wrapHook: async () => {
      wrapped++;
      return { ok: true, note: "collar refs cc-1/cc-2" };
    }
  }));
  assert.equal(ok.action, "opened");
  assert.equal(wrapped, 1);
  assert.match(loadPrincipalPairs(path)[0].notes.join(" "), /wrap: collar refs/);

  const path2 = freshPath();
  const fail = await runPrincipalPairCycle(new FakeVenue("hyperliquid"), new FakeVenue("paper2"), cfg(path2, {
    wrapHook: async () => ({ ok: false, note: "rfq no quotes" })
  }));
  assert.equal(fail.action, "opened", "wrap failure does not kill the delta-neutral pair");
  assert.match(loadPrincipalPairs(path2)[0].notes.join(" "), /WRAP FAILED/);
});

test("paper executor: fills at mid ± slippage and tracks positions both ways", async () => {
  const paper = new PaperPerpExecutor(async () => MID, { venueName: "paper" });
  const open = await paper.openLeg({ coin: "BTC", side: "short", notionalUsdc: 6_400 });
  assert.equal(open.status, "filled");
  assert.ok((open.avgPx ?? 0) < MID, "short opens below mid (slippage against us)");
  assert.ok((await paper.positionSz("BTC")) < 0);
  await paper.closeLeg({ coin: "BTC", side: "short", sz: open.filledSz });
  assert.ok(Math.abs(await paper.positionSz("BTC")) < 1e-9);
});
