import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTake,
  assessCohort,
  assessStrikeConcentration,
  deriveCaps,
  parseCapsInputsFromEnv,
  partialWrapSizing,
  registerWallet,
  takeRateFor,
  type CapsInputs,
  type WalletRegistry
} from "../src/singleSide/twoSided/creditCollar/capsConfig";

const NOW = 1_800_000_000_000;
const YEAR = 365 * 86_400_000;

const inputs = (over: Partial<CapsInputs> = {}): CapsInputs => ({
  ...parseCapsInputsFromEnv({}),
  ...over
});

// ── Formula derivation (decision 4) ───────────────────────────────────────────

test("caps: launch numbers — $10k capital, 12% margin, 40% headroom ⟹ $50k book / ~$2k per wallet", () => {
  const d = deriveCaps(inputs(), 63_000);
  assert.equal(d.usableMarginUsdc, 6_000); // 60% of $10k
  assert.equal(d.bookCapUsdc, 50_000); // 6000 / 0.12
  assert.equal(d.perWalletCapUsdc, 2_000); // 50k / 25 wallets
  assert.equal(d.maxWallets, 50);
  assert.equal(d.perStrikeCapPct, 0.3);
});

test("caps: raising capital raises EVERY cap by changing one input", () => {
  const d = deriveCaps(inputs({ subAccountCapitalUsdc: 100_000 }), 63_000);
  assert.equal(d.bookCapUsdc, 500_000);
  assert.equal(d.perWalletCapUsdc, 20_000);
});

test("caps: measured margin rate recalibrates the book (Phase 3 gate)", () => {
  const d = deriveCaps(inputs({ marginPerWrapRate: 0.15 }), 63_000);
  assert.equal(d.bookCapUsdc, 40_000); // 6000 / 0.15
});

test("caps: per-wallet cap floors at one OKX lot so small positions always fit", () => {
  // Tiny capital would push per-wallet under one lot — the floor holds it at 1 lot notional.
  const d = deriveCaps(inputs({ subAccountCapitalUsdc: 500 }), 63_000);
  assert.equal(d.perWalletCapUsdc, 630); // 0.01 BTC × $63k
});

test("caps: env parsing keeps launch defaults", () => {
  const i = parseCapsInputsFromEnv({});
  assert.equal(i.subAccountCapitalUsdc, 10_000);
  assert.equal(i.marginPerWrapRate, 0.12);
  assert.equal(i.headroomPct, 0.4);
  assert.equal(i.targetWallets, 25);
  assert.equal(i.foundingWallets, 50);
  assert.equal(i.takeRatePct, 0.2);
  assert.equal(i.foundingTakeRatePct, 0.1);
  assert.equal(i.deMinimisUsdc, 0.05);
  const custom = parseCapsInputsFromEnv({ EP_CAPITAL_USDC: "50000", EP_MARGIN_RATE: "0.1" });
  assert.equal(custom.subAccountCapitalUsdc, 50_000);
  assert.equal(custom.marginPerWrapRate, 0.1);
});

// ── Partial wraps (decision 6) ────────────────────────────────────────────────

test("partial wraps: an oversized position wraps up to the cap, rounded DOWN, with honest copy", () => {
  // $31k position, $2k wallet cap at $63k spot ⟹ 3 lots ($1,890), never refused.
  const s = partialWrapSizing(0.5, 31_500, 2_000, 0, 63_000);
  assert.ok(s.ok);
  if (!s.ok) return;
  assert.equal(s.lots, 3);
  assert.equal(s.coveredBtc, 0.03);
  assert.equal(s.coveredNotionalUsdc, 1_890);
  assert.equal(s.cappedByWallet, true);
  assert.match(s.coverageNote!, /Protected: \$1,890 of your \$31,500 position — coverage limits rise as capacity grows/);
});

test("partial wraps: a position inside the cap wraps fully (remainder note only when sub-lot dust)", () => {
  const full = partialWrapSizing(0.02, 1_260, 2_000, 0, 63_000);
  assert.ok(full.ok && full.lots === 2 && full.coverageNote === null && !full.cappedByWallet);
  const dust = partialWrapSizing(0.025, 1_575, 2_000, 0, 63_000);
  assert.ok(dust.ok);
  if (!dust.ok) return;
  assert.equal(dust.lots, 2); // floored, never rounded up (no naked exposure)
  assert.match(dust.coverageNote!, /protecting 0\.02 of 0\.025 BTC/);
});

test("partial wraps: wallet capacity already consumed ⟹ honest refusal; sub-lot position refused", () => {
  const used = partialWrapSizing(0.5, 31_500, 2_000, 1_900, 63_000);
  assert.ok(!used.ok && /capacity/.test(used.reason));
  const tiny = partialWrapSizing(0.009, 567, 2_000, 0, 63_000);
  assert.ok(!tiny.ok && /minimum one lot/.test(tiny.reason));
});

// ── Per-strike concentration ──────────────────────────────────────────────────

test("strike concentration: ≤30% of book notional short one strike", () => {
  const open = [
    { capStrike: 65_500, notionalUsdc: 4_000 },
    { capStrike: 66_000, notionalUsdc: 10_000 },
    { capStrike: 66_500, notionalUsdc: 10_000 }
  ];
  // Adding $4k more on 65500: strike = 8k of 28k book = 28.6% ⟹ ok.
  assert.deepEqual(assessStrikeConcentration(open, { capStrike: 65_500, notionalUsdc: 4_000 }, 0.3, 3, 63_000), { ok: true });
  // Adding $8k on 65500: strike = 12k of 32k = 37.5% ⟹ refused with honest copy.
  const refused = assessStrikeConcentration(open, { capStrike: 65_500, notionalUsdc: 8_000 }, 0.3, 3, 63_000);
  assert.ok(!refused.ok && /concentration|knockout|unwindable/i.test((refused as { reason: string }).reason));
});

test("strike concentration: the floor lets a thin book take its first wraps (share of nothing is 100%)", () => {
  // Empty book: 1 lot (~$630) on any strike is 100% of the book but under the 3-lot floor ⟹ ok.
  assert.deepEqual(assessStrikeConcentration([], { capStrike: 65_500, notionalUsdc: 630 }, 0.3, 3, 63_000), { ok: true });
  // But a single huge first wrap past the floor still binds.
  const big = assessStrikeConcentration([], { capStrike: 65_500, notionalUsdc: 5_000 }, 0.3, 3, 63_000);
  assert.equal(big.ok, false);
});

// ── Founding cohort + waitlist ────────────────────────────────────────────────

test("cohort: known wallets keep their slot; new wallets join while room; beyond ⟹ waitlist", () => {
  const registry: WalletRegistry = {};
  for (let i = 0; i < 50; i++) registry[`0x${String(i).padStart(40, "0")}`] = { joinedAtMs: NOW - i };
  const known = assessCohort(registry, `0x${String(7).padStart(40, "0")}`, 50);
  assert.ok(known.ok && known.founding && known.joinedAtMs === NOW - 7);
  const newWallet = assessCohort(registry, "0x" + "f".repeat(40), 50);
  assert.ok(!newWallet.ok && /waitlist/.test(newWallet.reason));
});

test("cohort: registration is idempotent and case-insensitive", () => {
  const registry: WalletRegistry = {};
  registerWallet(registry, "0xABCDEF" + "0".repeat(34), NOW);
  registerWallet(registry, "0xabcdef" + "0".repeat(34), NOW + 999);
  assert.equal(Object.keys(registry).length, 1);
  assert.equal(registry["0xabcdef" + "0".repeat(34)].joinedAtMs, NOW); // first join wins
  const d = assessCohort(registry, "0xAbCdEf" + "0".repeat(34), 50);
  assert.ok(d.ok && d.founding);
});

// ── Spread take (decision 3) ──────────────────────────────────────────────────

test("take: 20% standard / 10% founding locked 12 months, then standard", () => {
  const i = inputs();
  assert.deepEqual(takeRateFor(i, NOW, NOW + 1), { ratePct: 0.1, founding: true });
  assert.deepEqual(takeRateFor(i, NOW, NOW + YEAR - 1), { ratePct: 0.1, founding: true });
  assert.deepEqual(takeRateFor(i, NOW, NOW + YEAR), { ratePct: 0.2, founding: false }); // lock expired
  assert.deepEqual(takeRateFor(i, null, NOW), { ratePct: 0.2, founding: false });
});

test("take: the split is honest and the de minimis line waives tiny cuts to $0", () => {
  const std = applyTake(10, 0.2, 0.05);
  assert.equal(std.traderCreditUsdc, 8);
  assert.equal(std.atticusTakeUsdc, 2);
  assert.equal(std.appliedRatePct, 0.2);
  // 20% of $0.20 = $0.04 < $0.05 ⟹ waived entirely — the trader gets the full credit.
  const tiny = applyTake(0.2, 0.2, 0.05);
  assert.equal(tiny.traderCreditUsdc, 0.2);
  assert.equal(tiny.atticusTakeUsdc, 0);
  assert.equal(tiny.appliedRatePct, 0);
  // exactly at the line: $0.05 take stands.
  const at = applyTake(0.25, 0.2, 0.05);
  assert.equal(at.atticusTakeUsdc, 0.05);
  assert.equal(at.traderCreditUsdc, 0.2);
});

test("take: founding flag rides through; never negative", () => {
  const f = applyTake(1, 0.1, 0.05, true);
  assert.equal(f.founding, true);
  assert.equal(f.traderCreditUsdc, 0.9);
  const zero = applyTake(0, 0.2, 0.05);
  assert.equal(zero.traderCreditUsdc, 0);
  assert.equal(zero.atticusTakeUsdc, 0);
});
