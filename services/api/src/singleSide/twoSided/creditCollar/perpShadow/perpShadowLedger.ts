/**
 * The perp shadow ledger: the Earn & Protect collar quoted continuously from
 * the live OKX book at the demo's own terms, every quote a simulated position,
 * every position marked against the venue's official delivery price at expiry.
 *
 * Append-only JSONL, replayed on every read; money in integer cents; nothing
 * edited in place. Each open also carries what the OTHER rules would have
 * written from the same snapshot (tiers, fee rule, larger sizes), so the rule
 * comparison is measured, not argued.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { PerpSide } from "../creditCollarPricer";
import type { CollarGeometry } from "./okxListedSnapshot";

export type PerpTier = "tight" | "balanced" | "wide";
export const PERP_TIERS: readonly PerpTier[] = ["tight", "balanced", "wide"] as const;

/**
 * Geometry per tier, inside the live demo's bands (protective 2–8%, funding
 * 0.5–4%). Balanced IS the live product (6% / 1.5%); the others are what a
 * holder who wants more protection or more upside would be shown.
 */
export const PERP_TIER_GEOMETRY: Record<PerpTier, CollarGeometry> = {
  tight: { floorPct: 0.03, capPct: 0.01 },
  balanced: { floorPct: 0.06, capPct: 0.015 },
  wide: { floorPct: 0.08, capPct: 0.03 },
};

export const PERP_TIER_RULES: Record<PerpTier, string> = {
  tight: "floor 3% below entry, cap as wide as the book funds from 1%: the most protection the venue will pay for",
  balanced: "floor 6% below, cap from 1.5%: the live product's terms",
  wide: "floor 8% below, cap from 3%: the most upside kept, the deepest floor",
};

export type PerpTakeRule = "share" | "minimum" | "waived";

export interface PerpAltTerms {
  ok: true;
  floorStrikeCents: number;
  capStrikeCents: number;
  floorPct: number;
  capPct: number;
  buyInstId: string;
  sellInstId: string;
  buyPxBtc: number;
  sellPxBtc: number;
  grossCreditCents: number;
  venueFeeCents: number;
  netCreditCents: number;
  takeCents: number;
  takeRule: PerpTakeRule;
  creditCents: number;
  midCreditCents: number | null;
  levelsUsed: { buy: number; sell: number };
}
export interface PerpAltRefusal {
  ok: false;
  error: string;
  message: string;
}
export type PerpAlt = PerpAltTerms | PerpAltRefusal;

export interface PerpSizeProbe {
  mult: number;
  contracts: number;
  terms: PerpAlt;
}

export interface PerpFeeRuleAlt {
  rule: string;
  takeCents: number;
  creditCents: number;
  takeRule: PerpTakeRule;
  /** the rule would have refused: the take would consume the whole credit */
  refused: boolean;
}

/** The same geometry at another expiry; compared on quoted terms (it settles on a different print). */
export type PerpTenorAlt = (PerpAltTerms & { expiryIso: string }) | PerpAltRefusal;

export interface PerpShadowCounterfactuals {
  version: 1;
  tiers: Record<PerpTier, PerpAlt>;
  feeRules: Record<string, PerpFeeRuleAlt>;
  sizeLadder: PerpSizeProbe[];
  tenors: Record<string, PerpTenorAlt>;
}

export interface PerpShadowOpenRecord {
  type: "open";
  at: string;
  id: string;
  side: PerpSide;
  contracts: number;
  ctValBtc: number;
  /** contracts × ctVal × spot */
  notionalCents: number;
  /** Hyperliquid mark at open: the position's price */
  spotCents: number;
  /** OKX BTC-USD index at open, the hedge venue's price; null when unreadable */
  okxIndexCents: number | null;
  /** (HL mark − OKX index) / OKX index, bps; the basis the hedge carries */
  basisBps: number | null;
  /** Hyperliquid funding at open, bps per 8h; what holding the perp costs meanwhile */
  fundingBpsPer8h: number | null;
  expiryIso: string;
  tier: PerpTier;
  buyInstId: string;
  sellInstId: string;
  floorStrikeCents: number;
  capStrikeCents: number;
  floorPct: number;
  capPct: number;
  buyPxBtc: number;
  sellPxBtc: number;
  grossCreditCents: number;
  venueFeeCents: number;
  /** gross − venue fee: what the market funded */
  netCreditCents: number;
  takeCents: number;
  takeRule: PerpTakeRule;
  takeShareCents: number;
  takeMinimumCents: number;
  /** net − take: what the holder is paid */
  creditCents: number;
  /** the collar valued at venue mids; the spread we pay is mid − net */
  midCreditCents: number | null;
  counterfactuals: PerpShadowCounterfactuals | null;
}

export interface PerpShadowRefusalRecord {
  type: "refusal";
  at: string;
  side: PerpSide;
  contracts: number;
  spotCents: number;
  error: string;
  message: string;
}

export interface PerpShadowSettleRecord {
  type: "settle";
  at: string;
  id: string;
  settleCents: number;
  source: "okx_delivery" | "hl_mark";
}

export interface PerpShadowVoidRecord {
  type: "void";
  at: string;
  id: string;
  reason: string;
}

export type PerpShadowRecord = PerpShadowOpenRecord | PerpShadowRefusalRecord | PerpShadowSettleRecord | PerpShadowVoidRecord;

export interface PerpShadowPosition extends Omit<PerpShadowOpenRecord, "type"> {
  status: "open" | "settled" | "void";
  settledAt?: string;
  settleCents?: number;
  settleSource?: PerpShadowSettleRecord["source"];
  voidReason?: string;
  outcome?: PerpOutcome;
}

export interface PerpOutcome {
  nakedCents: number;
  protectedCents: number;
  /** protected − naked: what protection did for the holder */
  deltaCents: number;
  floorSave: boolean;
  capHit: boolean;
  /** the writer's side after the back-to-back hedge: the take, leg for leg */
  writerCents: number;
}

/** Cents of P&L on `qtyBtc` from `fromCents` to `toCents`, signed for the side. */
const pnlCents = (side: PerpSide, qtyBtc: number, fromCents: number, toCents: number): number =>
  Math.round(qtyBtc * (toCents - fromCents) * (side === "long" ? 1 : -1));

/**
 * The holder's two worlds at settlement. The collar clamps the exit between
 * floor and cap; the credit is theirs either way. Writer P&L is the take: the
 * hedge legs are the holder's terms bought and sold on the venue, so the
 * outcome cancels leg for leg and only the published take remains.
 */
export function perpOutcome(
  p: Pick<PerpShadowOpenRecord, "side" | "contracts" | "ctValBtc" | "spotCents" | "floorStrikeCents" | "capStrikeCents" | "creditCents" | "takeCents">,
  settleCents: number,
): PerpOutcome {
  const qty = p.contracts * p.ctValBtc;
  const lo = Math.min(p.floorStrikeCents, p.capStrikeCents);
  const hi = Math.max(p.floorStrikeCents, p.capStrikeCents);
  const clamped = Math.min(hi, Math.max(lo, settleCents));
  const naked = pnlCents(p.side, qty, p.spotCents, settleCents);
  const protectedPnl = pnlCents(p.side, qty, p.spotCents, clamped) + p.creditCents;
  const floorSave = p.side === "long" ? settleCents < p.floorStrikeCents : settleCents > p.floorStrikeCents;
  const capHit = p.side === "long" ? settleCents > p.capStrikeCents : settleCents < p.capStrikeCents;
  return { nakedCents: naked, protectedCents: protectedPnl, deltaCents: protectedPnl - naked, floorSave, capHit, writerCents: p.takeCents };
}

/** The same outcome for an alternative's terms on the same position and print. */
export function altOutcome(p: PerpShadowPosition, alt: PerpAltTerms, settleCents: number): PerpOutcome {
  return perpOutcome(
    {
      side: p.side,
      contracts: p.contracts,
      ctValBtc: p.ctValBtc,
      spotCents: p.spotCents,
      floorStrikeCents: alt.floorStrikeCents,
      capStrikeCents: alt.capStrikeCents,
      creditCents: alt.creditCents,
      takeCents: alt.takeCents,
    },
    settleCents,
  );
}

export function appendPerpShadowRecord(path: string, record: PerpShadowRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}

export function perpLedgerStats(path: string): { exists: boolean; bytes: number; records: number } {
  if (!existsSync(path)) return { exists: false, bytes: 0, records: 0 };
  const raw = readFileSync(path, "utf8");
  return { exists: true, bytes: statSync(path).size, records: raw.split("\n").filter((l) => l.trim()).length };
}

export function loadPerpShadowRecords(path: string): PerpShadowRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as PerpShadowRecord);
}

export function replayPerpShadow(records: PerpShadowRecord[]): { positions: PerpShadowPosition[]; refusals: PerpShadowRefusalRecord[] } {
  const byId = new Map<string, PerpShadowPosition>();
  const refusals: PerpShadowRefusalRecord[] = [];
  for (const r of records) {
    if (r.type === "open") {
      if (byId.has(r.id)) continue;
      const { type: _t, ...rest } = r;
      byId.set(r.id, { ...rest, status: "open" });
    } else if (r.type === "refusal") {
      refusals.push(r);
    } else if (r.type === "settle") {
      const p = byId.get(r.id);
      if (!p || p.status !== "open") continue;
      p.status = "settled";
      p.settledAt = r.at;
      p.settleCents = r.settleCents;
      p.settleSource = r.source;
      p.outcome = perpOutcome(p, r.settleCents);
    } else if (r.type === "void") {
      const p = byId.get(r.id);
      if (!p || p.status !== "open") continue;
      p.status = "void";
      p.voidReason = r.reason;
    }
  }
  return { positions: [...byId.values()], refusals };
}

export function loadPerpShadow(path: string): { positions: PerpShadowPosition[]; refusals: PerpShadowRefusalRecord[] } {
  return replayPerpShadow(loadPerpShadowRecords(path));
}

// ── Summary ─────────────────────────────────────────────────────────────────

export interface PerpRuleBook {
  quoted: number;
  refused: number;
  notionalCents: number;
  grossCreditCents: number;
  netCreditCents: number;
  takeCents: number;
  creditCents: number;
  /** holder credit per dollar of notional, bps (null until something is quoted) */
  creditBpsOfNotional: number | null;
  settled: number;
  floorSaves: number;
  capHits: number;
  holderDeltaCents: number;
  writerCents: number;
}

/** a fraction as bps to one decimal: a $0.09 credit on $2,400 is 0.4 bps, not 0 */
const bps1 = (frac: number): number => Math.round(frac * 100_000) / 10;

const emptyBook = (): PerpRuleBook => ({
  quoted: 0,
  refused: 0,
  notionalCents: 0,
  grossCreditCents: 0,
  netCreditCents: 0,
  takeCents: 0,
  creditCents: 0,
  creditBpsOfNotional: null,
  settled: 0,
  floorSaves: 0,
  capHits: 0,
  holderDeltaCents: 0,
  writerCents: 0,
});

const bookQuote = (b: PerpRuleBook, notionalCents: number, t: Pick<PerpAltTerms, "grossCreditCents" | "netCreditCents" | "takeCents" | "creditCents">): void => {
  b.quoted += 1;
  b.notionalCents += notionalCents;
  b.grossCreditCents += t.grossCreditCents;
  b.netCreditCents += t.netCreditCents;
  b.takeCents += t.takeCents;
  b.creditCents += t.creditCents;
};
const bookSettle = (b: PerpRuleBook, o: PerpOutcome): void => {
  b.settled += 1;
  if (o.floorSave) b.floorSaves += 1;
  if (o.capHit) b.capHits += 1;
  b.holderDeltaCents += o.deltaCents;
  b.writerCents += o.writerCents;
};
const finishBook = (b: PerpRuleBook): PerpRuleBook => ({
  ...b,
  creditBpsOfNotional: b.notionalCents > 0 ? bps1(b.creditCents / b.notionalCents) : null,
});

export interface PerpCounterfactualSummary {
  positionsWithCounterfactuals: number;
  recordedSince: string | null;
  baseline: PerpRuleBook;
  tiers: Record<PerpTier, PerpRuleBook>;
  feeRules: Record<string, PerpRuleBook>;
  /** the live tier re-quoted at larger sizes, walked down the depth */
  capacity: Array<PerpRuleBook & { mult: number; contracts: number; avgSpreadCostBps: number | null }>;
  /** the live geometry at other expiries; quoted terms only, never settled here */
  tenors: Record<string, PerpRuleBook & { avgDays: number | null }>;
}

export function summarizePerpCounterfactuals(positions: PerpShadowPosition[]): PerpCounterfactualSummary {
  const withCf = positions.filter((p) => p.counterfactuals);
  const baseline = emptyBook();
  const tiers: Record<PerpTier, PerpRuleBook> = { tight: emptyBook(), balanced: emptyBook(), wide: emptyBook() };
  const feeRules: Record<string, PerpRuleBook> = {};
  const tenors = new Map<string, PerpRuleBook & { dayNum: number; dayDen: number }>();
  const capacity = new Map<number, PerpRuleBook & { mult: number; contracts: number; spreadNum: number; spreadDen: number }>();
  for (const p of withCf) {
    const cf = p.counterfactuals!;
    const settled = p.status === "settled" && p.settleCents != null;
    bookQuote(baseline, p.notionalCents, p);
    if (settled && p.outcome) bookSettle(baseline, p.outcome);
    for (const t of PERP_TIERS) {
      const alt = cf.tiers[t];
      if (!alt) continue;
      if (!alt.ok) {
        tiers[t].refused += 1;
        continue;
      }
      bookQuote(tiers[t], p.notionalCents, alt);
      if (settled) bookSettle(tiers[t], altOutcome(p, alt, p.settleCents!));
    }
    for (const [label, fr] of Object.entries(cf.feeRules)) {
      feeRules[label] ??= emptyBook();
      if (fr.refused) {
        feeRules[label].refused += 1;
        continue;
      }
      const terms: PerpAltTerms = {
        ...(p as unknown as PerpAltTerms),
        ok: true,
        takeCents: fr.takeCents,
        creditCents: fr.creditCents,
        takeRule: fr.takeRule,
      };
      bookQuote(feeRules[label], p.notionalCents, terms);
      if (settled) bookSettle(feeRules[label], altOutcome(p, terms, p.settleCents!));
    }
    for (const [label, alt] of Object.entries(cf.tenors ?? {})) {
      const row = tenors.get(label) ?? { ...emptyBook(), dayNum: 0, dayDen: 0 };
      if (!alt.ok) row.refused += 1;
      else {
        bookQuote(row, p.notionalCents, alt);
        row.dayNum += (Date.parse(alt.expiryIso) - Date.parse(p.at)) / 86_400_000;
        row.dayDen += 1;
      }
      tenors.set(label, row);
    }
    for (const probe of cf.sizeLadder) {
      const row = capacity.get(probe.mult) ?? { ...emptyBook(), mult: probe.mult, contracts: 0, spreadNum: 0, spreadDen: 0 };
      row.contracts += probe.contracts;
      if (!probe.terms.ok) row.refused += 1;
      else {
        const notional = Math.round(probe.contracts * p.ctValBtc * p.spotCents);
        bookQuote(row, notional, probe.terms);
        if (probe.terms.midCreditCents != null && notional > 0) {
          row.spreadNum += ((probe.terms.midCreditCents - probe.terms.netCreditCents) / notional) * 10000;
          row.spreadDen += 1;
        }
        if (settled) bookSettle(row, altOutcome({ ...p, contracts: probe.contracts }, probe.terms, p.settleCents!));
      }
      capacity.set(probe.mult, row);
    }
  }
  return {
    positionsWithCounterfactuals: withCf.length,
    recordedSince: withCf.length ? withCf.map((p) => p.at).sort()[0] : null,
    baseline: finishBook(baseline),
    tiers: { tight: finishBook(tiers.tight), balanced: finishBook(tiers.balanced), wide: finishBook(tiers.wide) },
    feeRules: Object.fromEntries(Object.entries(feeRules).map(([k, v]) => [k, finishBook(v)])),
    tenors: Object.fromEntries(
      [...tenors.entries()].map(([k, { dayNum, dayDen, ...row }]) => [k, { ...finishBook(row), avgDays: dayDen > 0 ? +(dayNum / dayDen).toFixed(1) : null }]),
    ),
    capacity: [...capacity.values()]
      .sort((a, b) => a.mult - b.mult)
      .map(({ spreadNum, spreadDen, ...row }) => ({
        ...finishBook(row),
        mult: row.mult,
        contracts: row.contracts,
        avgSpreadCostBps: spreadDen > 0 ? Math.round((spreadNum / spreadDen) * 10) / 10 : null,
      })),
  };
}

export interface PerpShadowSummary {
  positions: number;
  open: number;
  settled: number;
  void: number;
  refusals: number;
  firstAt: string | null;
  lastAt: string | null;
  notionalCents: number;
  grossCreditCents: number;
  venueFeeCents: number;
  creditCents: number;
  takeCents: number;
  /** holder credit per dollar protected, bps of notional */
  creditBpsOfNotional: number | null;
  /** venue spread paid: mid-valued collar minus net funded, bps of notional, over positions with mids */
  spreadCostBps: number | null;
  floorSaves: number;
  capHits: number;
  holderDeltaCents: number;
  holderNakedCents: number;
  holderProtectedCents: number;
  writerCents: number;
  bySide: Record<PerpSide, { positions: number; settled: number; creditCents: number; holderDeltaCents: number }>;
  refusalReasons: Record<string, number>;
  avgFundingBpsPer8h: number | null;
  avgBasisBps: number | null;
  counterfactuals: PerpCounterfactualSummary;
}

export function summarizePerpShadow(positions: PerpShadowPosition[], refusals: PerpShadowRefusalRecord[]): PerpShadowSummary {
  const s: PerpShadowSummary = {
    positions: positions.length,
    open: 0,
    settled: 0,
    void: 0,
    refusals: refusals.length,
    firstAt: null,
    lastAt: null,
    notionalCents: 0,
    grossCreditCents: 0,
    venueFeeCents: 0,
    creditCents: 0,
    takeCents: 0,
    creditBpsOfNotional: null,
    spreadCostBps: null,
    floorSaves: 0,
    capHits: 0,
    holderDeltaCents: 0,
    holderNakedCents: 0,
    holderProtectedCents: 0,
    writerCents: 0,
    bySide: {
      long: { positions: 0, settled: 0, creditCents: 0, holderDeltaCents: 0 },
      short: { positions: 0, settled: 0, creditCents: 0, holderDeltaCents: 0 },
    },
    refusalReasons: {},
    avgFundingBpsPer8h: null,
    avgBasisBps: null,
    counterfactuals: summarizePerpCounterfactuals(positions),
  };
  const ats = [...positions.map((p) => p.at), ...refusals.map((r) => r.at)].sort();
  s.firstAt = ats[0] ?? null;
  s.lastAt = ats[ats.length - 1] ?? null;
  let spreadNum = 0;
  let spreadDen = 0;
  let fundNum = 0;
  let fundDen = 0;
  let basisNum = 0;
  let basisDen = 0;
  for (const p of positions) {
    s[p.status] += 1;
    s.notionalCents += p.notionalCents;
    s.grossCreditCents += p.grossCreditCents;
    s.venueFeeCents += p.venueFeeCents;
    s.creditCents += p.creditCents;
    s.takeCents += p.takeCents;
    s.bySide[p.side].positions += 1;
    s.bySide[p.side].creditCents += p.creditCents;
    if (p.midCreditCents != null && p.notionalCents > 0) {
      spreadNum += ((p.midCreditCents - p.netCreditCents) / p.notionalCents) * 10000;
      spreadDen += 1;
    }
    if (p.fundingBpsPer8h != null) {
      fundNum += p.fundingBpsPer8h;
      fundDen += 1;
    }
    if (p.basisBps != null) {
      basisNum += p.basisBps;
      basisDen += 1;
    }
    if (p.status === "settled" && p.outcome) {
      const o = p.outcome;
      if (o.floorSave) s.floorSaves += 1;
      if (o.capHit) s.capHits += 1;
      s.holderDeltaCents += o.deltaCents;
      s.holderNakedCents += o.nakedCents;
      s.holderProtectedCents += o.protectedCents;
      s.writerCents += o.writerCents;
      s.bySide[p.side].settled += 1;
      s.bySide[p.side].holderDeltaCents += o.deltaCents;
    }
  }
  for (const r of refusals) s.refusalReasons[r.error] = (s.refusalReasons[r.error] ?? 0) + 1;
  s.creditBpsOfNotional = s.notionalCents > 0 ? bps1(s.creditCents / s.notionalCents) : null;
  s.spreadCostBps = spreadDen > 0 ? Math.round((spreadNum / spreadDen) * 10) / 10 : null;
  s.avgFundingBpsPer8h = fundDen > 0 ? +(fundNum / fundDen).toFixed(3) : null;
  s.avgBasisBps = basisDen > 0 ? +(basisNum / basisDen).toFixed(1) : null;
  return s;
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const PERP_CSV_PUBLIC_COLUMNS = [
  "id",
  "side",
  "opened_at_utc",
  "expiry_utc",
  "status",
  "settled_at_utc",
  "settle_px_c",
  "settle_source",
  "contracts",
  "notional_c",
  "spot_c",
  "okx_index_c",
  "basis_bps",
  "funding_bps_8h",
  "floor_strike_c",
  "cap_strike_c",
  "floor_pct",
  "cap_pct",
  "buy_inst",
  "sell_inst",
  "buy_px_btc",
  "sell_px_btc",
  "gross_credit_c",
  "venue_fee_c",
  "net_credit_c",
  "take_c",
  "credit_c",
  "mid_credit_c",
  "holder_naked_c",
  "holder_protected_c",
  "holder_delta_c",
  "floor_save",
  "cap_hit",
  "writer_c",
  "tier",
] as const;

export const PERP_CSV_COLUMNS = [
  ...PERP_CSV_PUBLIC_COLUMNS,
  "take_rule",
  "take_share_c",
  "take_min_c",
  ...PERP_TIERS.flatMap((t) => [`${t}_floor_c`, `${t}_cap_c`, `${t}_gross_c`, `${t}_credit_c`, `${t}_take_c`, `${t}_holder_delta_c`, `${t}_refused`]),
  "fee_rules",
  "size_ladder",
  "weekly_expiry_utc",
  "weekly_floor_c",
  "weekly_cap_c",
  "weekly_gross_c",
  "weekly_credit_c",
  "weekly_take_c",
  "weekly_refused",
] as const;

const cell = (v: string | number | boolean | null | undefined): string => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "boolean" ? (v ? "1" : "0") : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const weeklyCells = (alt: PerpTenorAlt | undefined): Array<string | number> => {
  if (!alt) return ["", "", "", "", "", "", ""];
  if (!alt.ok) return ["", "", "", "", "", "", 1];
  return [alt.expiryIso, alt.floorStrikeCents, alt.capStrikeCents, alt.grossCreditCents, alt.creditCents, alt.takeCents, 0];
};

export function perpPositionsCsv(positions: PerpShadowPosition[], scope: "public" | "full" = "full"): string {
  const cols = scope === "public" ? PERP_CSV_PUBLIC_COLUMNS : PERP_CSV_COLUMNS;
  const rows = [...positions]
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((p) => {
      const o = p.outcome;
      const pub: Array<string | number | boolean | null | undefined> = [
        p.id,
        p.side,
        p.at,
        p.expiryIso,
        p.status,
        p.settledAt ?? "",
        p.settleCents ?? "",
        p.settleSource ?? "",
        p.contracts,
        p.notionalCents,
        p.spotCents,
        p.okxIndexCents,
        p.basisBps,
        p.fundingBpsPer8h,
        p.floorStrikeCents,
        p.capStrikeCents,
        p.floorPct,
        p.capPct,
        p.buyInstId,
        p.sellInstId,
        p.buyPxBtc,
        p.sellPxBtc,
        p.grossCreditCents,
        p.venueFeeCents,
        p.netCreditCents,
        p.takeCents,
        p.creditCents,
        p.midCreditCents,
        o?.nakedCents ?? "",
        o?.protectedCents ?? "",
        o?.deltaCents ?? "",
        o ? o.floorSave : "",
        o ? o.capHit : "",
        o?.writerCents ?? "",
        p.tier,
      ];
      if (scope === "public") return pub.map(cell).join(",");
      const cf = p.counterfactuals;
      const tierCells = PERP_TIERS.flatMap((t) => {
        const alt = cf?.tiers[t];
        if (!alt) return ["", "", "", "", "", "", ""];
        if (!alt.ok) return ["", "", "", "", "", "", 1];
        const out = p.status === "settled" && p.settleCents != null ? altOutcome(p, alt, p.settleCents) : null;
        return [alt.floorStrikeCents, alt.capStrikeCents, alt.grossCreditCents, alt.creditCents, alt.takeCents, out?.deltaCents ?? "", 0];
      });
      return [
        ...pub,
        p.takeRule,
        p.takeShareCents,
        p.takeMinimumCents,
        ...tierCells,
        cf ? JSON.stringify(cf.feeRules) : "",
        cf ? JSON.stringify(cf.sizeLadder.map((s) => ({ mult: s.mult, contracts: s.contracts, ok: s.terms.ok, credit: s.terms.ok ? s.terms.creditCents : null, error: s.terms.ok ? null : s.terms.error }))) : "",
        ...weeklyCells(cf?.tenors?.weekly),
      ]
        .map(cell)
        .join(",");
    });
  return [cols.join(","), ...rows].join("\n") + "\n";
}
