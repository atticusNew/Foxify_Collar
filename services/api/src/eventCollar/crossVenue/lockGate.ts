/**
 * LOCK GATE: who may ask the shadow to open a position for a real holder.
 *
 * The scan opens positions on its own schedule for a simulated holder. The lock endpoint opens one
 * for a person who tapped Lock in on a real position (the browser extension over a venue's page),
 * at their size, and fills the hedge through the same executor. That is a write to the record and,
 * in live mode, an order on a venue, so it is gated by a dedicated key: EVENT_SHADOW_LOCK_KEY,
 * sent as `x-lock-key` (or `?lock=`). Unset, the endpoint does not exist (404 like any unknown
 * path): fail closed. The operator token also opens it.
 *
 * The key is not a venue credential. It lets a client ask; the rails decide what is sent.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ProtectionTier } from "./types";

export const PROTECTION_TIER_NAMES: readonly ProtectionTier[] = ["tight", "balanced", "wide"];

export function lockKeyFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.EVENT_SHADOW_LOCK_KEY?.trim();
  return k && k.length >= 12 ? k : null;
}

function same(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** True when the request carries the lock key. A null key authorizes nothing. */
export function lockAuthorized(key: string | null, headers: IncomingHttpHeaders, query: string | null): boolean {
  if (!key) return false;
  const h = headers["x-lock-key"];
  const sent = (Array.isArray(h) ? h[0] : h) ?? query ?? "";
  return sent.length > 0 && same(sent, key);
}

/** The whole body as JSON, or null when it is not JSON, is empty, or exceeds `maxBytes`. */
export function readJsonBody(req: IncomingMessage, maxBytes = 16_384): Promise<unknown | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: unknown | null): void => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        finish(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        finish(null);
        return;
      }
      try {
        finish(JSON.parse(text));
      } catch {
        finish(null);
      }
    });
    req.on("error", () => finish(null));
  });
}

export interface LockRequest {
  ticker: string;
  contracts: number;
  entryCents?: number;
  tier?: ProtectionTier;
}

/** Validate a lock body. Tickers are upper-cased; sizes and prices must be whole numbers in range. */
export function parseLockRequest(body: unknown): { ok: true; value: LockRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const ticker = typeof b.ticker === "string" ? b.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9-]{2,80}$/.test(ticker)) return { ok: false, error: "ticker must be a Kalshi market ticker" };
  const contracts = typeof b.contracts === "number" ? b.contracts : Number(b.contracts);
  if (!Number.isInteger(contracts) || contracts < 1 || contracts > 10_000) return { ok: false, error: "contracts must be a whole number from 1 to 10,000" };
  const value: LockRequest = { ticker, contracts };
  if (b.entryCents !== undefined && b.entryCents !== null) {
    const e = typeof b.entryCents === "number" ? b.entryCents : Number(b.entryCents);
    if (!Number.isInteger(e) || e < 1 || e > 99) return { ok: false, error: "entryCents must be whole cents from 1 to 99" };
    value.entryCents = e;
  }
  if (b.tier !== undefined && b.tier !== null) {
    if (typeof b.tier !== "string" || !PROTECTION_TIER_NAMES.includes(b.tier as ProtectionTier)) {
      return { ok: false, error: "tier must be tight, balanced or wide" };
    }
    value.tier = b.tier as ProtectionTier;
  }
  return { ok: true, value };
}
