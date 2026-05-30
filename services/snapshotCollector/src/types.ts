import { z } from "zod";

// ─────────────────────────────────────────────────────────────────────
// Schemas mirror the live `foxify-pilot-new` admin endpoint shapes.
// Source of truth lives in services/api/src/volumeCover/volumeCoverRoutes.ts
// — keep in sync if the live API changes (the collector will surface
// schema-mismatch errors via the snapshot_run.error_message column).
// ─────────────────────────────────────────────────────────────────────

export const HealthResponseSchema = z.object({
  ok: z.boolean().optional(),
  status: z.string().optional(),
  spotBtcUsdc: z.number().optional(),
  haltStatus: z.unknown().optional()
}).passthrough();
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const DashboardResponseSchema = z.object({
  halted: z.boolean().optional(),
  activePositions: z.number().optional(),
  guardStatuses: z.unknown().optional()
}).passthrough();
export type DashboardResponse = z.infer<typeof DashboardResponseSchema>;

export const ActivePositionDetailSchema = z.object({
  id: z.string(),
  cellId: z.string().optional(),
  status: z.string().optional(),
  salvageState: z.string().optional(),
  triggerHighBtc: z.number().optional(),
  triggerLowBtc: z.number().optional(),
  payoutUsdc: z.number().optional(),
  dailyPremiumUsdc: z.number().optional(),
  hedgeBuyUsdc: z.number().optional(),
  hedgeSellUsdc: z.number().optional(),
  legs: z.array(z.object({
    id: z.string(),
    venue: z.string().optional(),
    optionKind: z.string().optional(),
    strikeUsdc: z.number().optional(),
    expiryIso: z.string().optional(),
    contractsBtc: z.number().optional(),
    status: z.string().optional(),
    buyFillPriceUsdc: z.number().optional(),
    sellFillPriceUsdc: z.number().optional()
  })).optional()
}).passthrough();
export type ActivePositionDetail = z.infer<typeof ActivePositionDetailSchema>;

export const ActivePositionsDetailResponseSchema = z.object({
  positions: z.array(ActivePositionDetailSchema)
}).passthrough();
export type ActivePositionsDetailResponse = z.infer<typeof ActivePositionsDetailResponseSchema>;

export const AllOpenLegsResponseSchema = z.object({
  count: z.number().optional(),
  legs: z.array(z.object({
    id: z.string(),
    positionId: z.string().optional(),
    venue: z.string().optional(),
    optionKind: z.string().optional(),
    strikeUsdc: z.number().optional(),
    expiryIso: z.string().optional(),
    status: z.string().optional()
  }).passthrough()).optional()
}).passthrough();
export type AllOpenLegsResponse = z.infer<typeof AllOpenLegsResponseSchema>;

export const PoolLedgerEntrySchema = z.object({
  id: z.string().optional(),
  ts: z.string().optional(),
  kind: z.string().optional(),
  amountUsdc: z.number().optional(),
  positionId: z.string().optional(),
  legId: z.string().optional()
}).passthrough();

export const PoolLedgerResponseSchema = z.object({
  poolId: z.string().optional(),
  entries: z.array(PoolLedgerEntrySchema).optional()
}).passthrough();
export type PoolLedgerResponse = z.infer<typeof PoolLedgerResponseSchema>;

export const HedgeManagerDryRunResponseSchema = z.object({
  legsScanned: z.number().optional(),
  legsActioned: z.number().optional(),
  actions: z.array(z.object({
    legId: z.string().optional(),
    rule: z.number().optional(),
    action: z.string().optional(),
    reason: z.string().optional()
  }).passthrough()).optional()
}).passthrough();
export type HedgeManagerDryRunResponse = z.infer<typeof HedgeManagerDryRunResponseSchema>;

export type EndpointKind =
  | "health"
  | "dashboard"
  | "active-positions-detail"
  | "all-open-legs"
  | "pool-ledger-atticus"
  | "pool-ledger-foxify"
  | "hedge-manager-dry-run";
