/**
 * A position as the public record carries it (GET /api/shadow): the holder's side of it. What
 * was quoted, the terms, the official result and what the holder ended with, with and without
 * the lock. Our side of each row (the take and how it was set, the fees, the hedge and where it
 * was bought, our result) is the operator's: the raw ledger, the full CSV, /venues. The totals
 * of our side are on the record page.
 *
 * The fields are listed one by one, so a field added to the ledger is not public until it is
 * added here.
 */

import { cashDue, type MemberBuyBackRecord, type MemberSaleComparison, type MemberSaleRecord, type ShadowPosition } from "./shadowLedger";

const PUBLIC_FIELDS = [
  "at",
  "ticker",
  "kind",
  "league",
  "sideName",
  "eventTitle",
  "eventTimeIso",
  "contracts",
  "markCents",
  "floorCents",
  "capCents",
  "creditCents",
  "evCostBps",
  "tier",
  // the rule text of the market the holder is in, and of the market its price is read from
  "rule",
  "referenceRule",
  "holderVenue",
  "source",
  "entryCents",
  "parlay",
  "status",
  "result",
  "settledAt",
  "ruleCheck",
  "referenceRuleCheck",
  "voidReason",
  "protectedCents",
  "nakedCents",
  "deltaCents",
  "closedAt",
  "closeYesMidCents",
  "closeYesFillCents",
  "closeFeesCents",
  "closeProtectedAtMidCents",
  "closeUnwindFrictionCents",
  "closeSource",
  "generation",
  "cash",
] as const satisfies ReadonlyArray<keyof ShadowPosition>;

type PublicField = (typeof PUBLIC_FIELDS)[number];

/** The comparison beside a member's own sale, without which venue a hedged lock would have gone to. */
export type PublicSaleComparison = Omit<MemberSaleComparison, "chosen" | "routes"> & { priced?: number };

export type PublicMemberSale = Omit<MemberSaleRecord, "venueFills" | "compared"> & { compared?: PublicSaleComparison };

export type PublicPosition = Pick<ShadowPosition, PublicField> & {
  /** present only on a member's own sale; a hedged lock does not say where the other side was bought */
  route?: "member_sale";
  memberSale?: PublicMemberSale;
  closeMemberBuyBack?: MemberBuyBackRecord;
  /** when a close could not be priced; the reason stays with the operator */
  closeUnpriced?: { at: string };
  /** a holder's lock: what it owes and what was paid */
  cashDue?: ReturnType<typeof cashDue>;
};

function publicComparison(c: MemberSaleComparison): PublicSaleComparison {
  const { chosen: _chosen, routes, ...rest } = c;
  return routes ? { ...rest, priced: routes.filter((r) => r.ok).length } : rest;
}

/** A member's own sale: the venue's order ids, market id and fill-by-fill detail stay with the member and the operator; the summed figures are public. */
function publicMemberSale(s: MemberSaleRecord): PublicMemberSale {
  const { venueFills: _fills, compared, ...rest } = s;
  return { ...rest, marketId: "", orderId: null, clientOrderId: "", ...(compared ? { compared: publicComparison(compared) } : {}) };
}

function publicMemberBuyBack(b: MemberBuyBackRecord): MemberBuyBackRecord {
  const { venueFills: _fills, ...rest } = b;
  return { ...rest, orderId: null, clientOrderId: "" };
}

export function publicPosition(p: ShadowPosition): PublicPosition {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_FIELDS) if (p[k] !== undefined) out[k] = p[k];
  if (p.route === "member_sale") out.route = "member_sale";
  if (p.memberSale) out.memberSale = publicMemberSale(p.memberSale);
  if (p.closeMemberBuyBack) out.closeMemberBuyBack = publicMemberBuyBack(p.closeMemberBuyBack);
  if (p.closeUnpriced) out.closeUnpriced = { at: p.closeUnpriced.at };
  // a holder's lock carries what it owes and what was paid; the scan's positions pay nobody
  if (p.source === "lock") out.cashDue = cashDue(p);
  return out as unknown as PublicPosition;
}
