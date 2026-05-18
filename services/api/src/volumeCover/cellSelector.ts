/**
 * Cell selection — maps quote/activate request inputs to a matrix cell.
 *
 * Foxify can request either by exact cellId or by (notional, triggerPct)
 * dimensions. We accept both for ergonomic flexibility.
 */

import { findCellById, findCellByDimensions, type CellDefinition } from "./matrix";

export type CellSelectionRequest =
  | { cellId: string }
  | { notionalUsdc: number; triggerPct: number };

export type CellSelectionResult =
  | { ok: true; cell: CellDefinition }
  | { ok: false; reason: "cell_not_found"; details: Record<string, unknown> };

export const selectCell = (request: CellSelectionRequest): CellSelectionResult => {
  if ("cellId" in request) {
    const cell = findCellById(request.cellId);
    if (!cell) {
      return {
        ok: false,
        reason: "cell_not_found",
        details: { requestedCellId: request.cellId }
      };
    }
    return { ok: true, cell };
  }
  const cell = findCellByDimensions({
    notionalUsdc: request.notionalUsdc,
    triggerPct: request.triggerPct
  });
  if (!cell) {
    return {
      ok: false,
      reason: "cell_not_found",
      details: {
        requestedNotionalUsdc: request.notionalUsdc,
        requestedTriggerPct: request.triggerPct
      }
    };
  }
  return { ok: true, cell };
};
