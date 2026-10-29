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
 *
 * HOLDERS. A pilot has several people locking, each from their own venue account, and the record
 * has to know whose lock is whose: the credit is paid to a person, the handback is owed by one.
 * EVENT_SHADOW_HOLDER_KEYS names them: `ann:<key>,bob:<key>` (commas, spaces or newlines between
 * pairs). A request carrying a holder's key is that holder; the shared EVENT_SHADOW_LOCK_KEY stays
 * what it was (the operator's own client, no holder). The holder comes from the key alone, never
 * from the body, so nobody can lock as somebody else. A holder's alias is short and lower-case; it
 * names their ledger file and appears on the operator's views, never on the public record.
 */

import { timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ProtectionTier } from "./types";
import { roundContracts } from "./types";
import { isSettlementVenue, type SettlementVenue } from "./hedgeRouting";

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

// ---------------------------------------------------------------------------
// holders
// ---------------------------------------------------------------------------

export interface HolderKey {
  /** the alias: 2 to 24 of a-z 0-9 _ -, starting with a letter or digit */
  holder: string;
  key: string;
}

export const HOLDER_ALIAS_RE = /^[a-z0-9][a-z0-9_-]{1,23}$/;

/**
 * EVENT_SHADOW_HOLDER_KEYS parsed: `alias:key` pairs. A pair with a bad alias, a key under 12
 * chars, a key equal to the shared key, or an alias or key already seen is dropped with a note,
 * never silently accepted: two people on one key would be one person to the record.
 */
export function holderKeysFromEnv(env: NodeJS.ProcessEnv = process.env, sharedKey: string | null = lockKeyFromEnv(env)): { holders: HolderKey[]; notes: string[] } {
  const raw = env.EVENT_SHADOW_HOLDER_KEYS ?? "";
  const holders: HolderKey[] = [];
  const notes: string[] = [];
  const aliases = new Set<string>();
  const keys = new Set<string>();
  for (const pair of raw.split(/[,\s]+/)) {
    if (!pair) continue;
    const i = pair.indexOf(":");
    const holder = (i === -1 ? pair : pair.slice(0, i)).trim().toLowerCase();
    const key = i === -1 ? "" : pair.slice(i + 1).trim();
    if (!HOLDER_ALIAS_RE.test(holder)) {
      notes.push(`holder keys: alias "${holder.slice(0, 24)}" is not 2-24 of a-z 0-9 _ -; dropped`);
      continue;
    }
    if (key.length < 12) {
      notes.push(`holder keys: ${holder}: key under 12 chars; dropped`);
      continue;
    }
    if (sharedKey && same(key, sharedKey)) {
      notes.push(`holder keys: ${holder}: key equals the shared lock key; dropped`);
      continue;
    }
    if (aliases.has(holder)) {
      notes.push(`holder keys: ${holder}: alias listed twice; second dropped`);
      continue;
    }
    if (keys.has(key)) {
      notes.push(`holder keys: ${holder}: key already belongs to another holder; dropped`);
      continue;
    }
    aliases.add(holder);
    keys.add(key);
    holders.push({ holder, key });
  }
  return { holders, notes };
}

/** Who is asking: the shared key (no holder), one of the holders, or nobody. */
export type LockCaller = { kind: "shared"; holder: null } | { kind: "holder"; holder: string };

export function lockCaller(sharedKey: string | null, holders: readonly HolderKey[], headers: IncomingHttpHeaders, query: string | null): LockCaller | null {
  const h = headers["x-lock-key"];
  const sent = (Array.isArray(h) ? h[0] : h) ?? query ?? "";
  if (sent.length === 0) return null;
  if (sharedKey && same(sent, sharedKey)) return { kind: "shared", holder: null };
  // every holder's key is compared so the time taken does not say which alias exists
  let found: string | null = null;
  for (const hk of holders) if (same(sent, hk.key)) found = hk.holder;
  return found ? { kind: "holder", holder: found } : null;
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
  /** where the holder's position lives (the extension's venue); absent, Kalshi */
  venue?: SettlementVenue;
}

/**
 * Validate a lock body. Tickers are upper-cased; the size is contracts to the hundredth (Kalshi
 * sells fractions; a $7.69 payout elsewhere is 7.69 contracts), at least one, and prices are whole
 * cents. A size given finer than a hundredth is refused rather than rounded: the venue's own
 * figure is always a hundredth, so anything finer is a client bug.
 */
export function parseLockRequest(body: unknown): { ok: true; value: LockRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const ticker = typeof b.ticker === "string" ? b.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z0-9][A-Z0-9-]{2,80}$/.test(ticker)) return { ok: false, error: "ticker must be a Kalshi market ticker" };
  const raw = typeof b.contracts === "number" ? b.contracts : Number(b.contracts);
  const contracts = roundContracts(raw);
  if (!Number.isFinite(raw) || Math.abs(raw - contracts) > 1e-9 || contracts < 1 || contracts > 10_000) {
    return { ok: false, error: "contracts must be from 1 to 10,000, to the hundredth of a contract" };
  }
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
  if (b.venue !== undefined && b.venue !== null && b.venue !== "") {
    const v = typeof b.venue === "string" ? b.venue.trim().toLowerCase() : "";
    if (!isSettlementVenue(v)) return { ok: false, error: "venue must be kalshi, polymarket, prophetx or novig" };
    value.venue = v;
  }
  return { ok: true, value };
}
