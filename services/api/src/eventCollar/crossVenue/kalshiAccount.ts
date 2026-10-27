/**
 * Kalshi account administration — what the operator does once, from the service, so a pod on the
 * aggregator can be handed a subaccount of our own making.
 *
 * Why this exists: the aggregator trades one numbered Kalshi subaccount per pod. Creating a
 * subaccount is an Advanced-tier endpoint on Kalshi, the tiers are API rate-limit tiers (not
 * account types) and none of it has a page in Kalshi's web app. So the steps are API calls, and
 * they run here with the same key the direct live hedge already holds.
 *
 * Wire facts (Kalshi Trade API):
 *   GET  /account/limits                         -> {usage_tier, read, write, grants[]}
 *   POST /account/api_usage_level/upgrade        -> 201 permanent Advanced grant; 403 when none of the
 *                                                   last 100 Predictions orders was created via API
 *   GET  /portfolio/balance                      -> {balance (cents), balance_dollars, balance_breakdown[{exchange_index, balance}]}
 *   GET  /portfolio/subaccounts/balances         -> {subaccount_balances[{subaccount_number, exchange_index, balance, updated_ts}]}
 *   POST /portfolio/subaccounts {exchange_index?}                       -> 201 {subaccount_number}
 *   POST /portfolio/subaccounts/transfer {client_transfer_id, from_subaccount, to_subaccount, amount_cents, exchange_index?}
 *   POST /portfolio/intra_exchange_instance_transfer {source, destination, amount (centicents),
 *        source_exchange_shard, destination_exchange_shard, source_subaccount, destination_subaccount, client_transfer_id?}
 *                                                -> {transfer_id}; moves cash between exchange shards
 *
 * Shards: Kalshi runs several matching engines and a subaccount's cash is PER SHARD. NFL and the
 * catch-all are shard 0; Basketball, Baseball and Tennis are shard 3. A subaccount that will hedge
 * both leagues needs cash on both.
 *
 * Nothing here places an order. Every call is a read or a transfer inside the same account.
 */

import { randomUUID } from "node:crypto";
import { kalshiBase } from "../kalshiPublic";
import { kalshiAuthHeaders, type KalshiRfqCredentials } from "./kalshiRfq";
import { decimalToMilli } from "./polymarketPublic";

/** Kalshi's own series shard assignments as documented; shard 0 is the catch-all. */
export const KALSHI_SHARDS: Record<number, string> = {
  0: "default (NFL, everything not listed)",
  1: "exotics / combos",
  2: "crypto, commodities",
  3: "sports: basketball, baseball, tennis",
};

/** The shard a sports ticker trades on, from its series prefix. Unknown prefixes are the catch-all. */
export function shardForTicker(ticker: string): number {
  const t = ticker.toUpperCase();
  if (/^KX(NBA|WNBA|NCAAB|NCAAMB|NCAAWB|MLB|ATP|WTA|TENNIS|CBB)/.test(t)) return 3;
  return 0;
}

export interface KalshiTierGrant {
  exchangeInstance: string;
  level: string;
  source: string;
  /** unix seconds; null for a permanent grant */
  expiresTs: number | null;
}

export interface KalshiTier {
  usageTier: string;
  read: { refillRate: number; bucketCapacity: number };
  write: { refillRate: number; bucketCapacity: number };
  grants: KalshiTierGrant[];
  /** Advanced or above: the account can create subaccounts */
  canCreateSubaccounts: boolean;
}

export const TIER_RANK: Record<string, number> = { basic: 0, advanced: 1, expert: 2, premier: 3, paragon: 4, prime: 5, prestige: 6 };

export interface KalshiShardBalance {
  exchangeIndex: number;
  cents: number;
}

export interface KalshiSubaccountBalance {
  subaccount: number;
  exchangeIndex: number;
  cents: number;
  updatedTs: number;
}

export interface KalshiAccountSnapshot {
  tier: KalshiTier;
  /** the whole account, every shard */
  balanceCents: number;
  byShard: KalshiShardBalance[];
  subaccounts: KalshiSubaccountBalance[];
}

export type UpgradeResult = { ok: true; status: number; tier: KalshiTier } | { ok: false; status: number; reason: string; tier: KalshiTier | null };

/** dollars string -> cents, rounded down (a balance is never over-read). */
export function dollarsToCentsFloor(v: string | undefined): number {
  const milli = decimalToMilli(v, false);
  return milli < 0 ? 0 : Math.floor(milli / 10);
}

export class KalshiApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly method: string,
    public readonly endpoint: string,
    public readonly body: string,
  ) {
    super(`kalshi account: HTTP ${status} ${method} ${endpoint}${body ? ` ${body.slice(0, 200)}` : ""}`);
  }
}

export interface KalshiAccountClientOptions {
  base?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  uuid?: () => string;
}

export class KalshiAccountClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly uuid: () => string;

  constructor(
    private readonly creds: KalshiRfqCredentials,
    opts: KalshiAccountClientOptions = {},
  ) {
    this.base = (opts.base ?? process.env.KALSHI_TRADE_BASE ?? kalshiBase()).replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? Number(process.env.EVENT_FETCH_TIMEOUT_MS || 8000);
    this.uuid = opts.uuid ?? randomUUID;
  }

  async tier(): Promise<KalshiTier> {
    const raw = (await this.call("GET", "/account/limits")) as {
      usage_tier?: string;
      read?: { refill_rate?: number; bucket_capacity?: number };
      write?: { refill_rate?: number; bucket_capacity?: number };
      grants?: Array<{ exchange_instance?: string; level?: string; source?: string; expires_ts?: number | null }>;
    } | null;
    return parseTier(raw);
  }

  /**
   * Ask Kalshi for the permanent Advanced grant. 201 when granted (or refreshed); 403 when none of
   * the account's last 100 Predictions orders was created through the API. The tier is read back
   * either way so the caller sees where the account stands.
   */
  async upgradeToAdvanced(): Promise<UpgradeResult> {
    const r = await this.raw("POST", "/account/api_usage_level/upgrade");
    const tier = await this.tier().catch(() => null);
    if (r.status === 201 || r.status === 200) {
      return { ok: true, status: r.status, tier: tier ?? parseTier(null) };
    }
    const reason =
      r.status === 403
        ? "no API-created order among the account's last 100 Predictions orders; place one through the API (any size, it may be cancelled) and call again"
        : r.status === 429
          ? "rate limited (30 tokens from the Write bucket); wait a second and call again"
          : `HTTP ${r.status}${r.text ? ` ${r.text.slice(0, 200)}` : ""}`;
    return { ok: false, status: r.status, reason, tier };
  }

  /** The account's cash, whole and per shard. */
  async balance(): Promise<{ balanceCents: number; byShard: KalshiShardBalance[] }> {
    const raw = (await this.call("GET", "/portfolio/balance")) as {
      balance?: number;
      balance_dollars?: string;
      balance_breakdown?: Array<{ exchange_index?: number; balance?: string }>;
    } | null;
    const balanceCents = raw?.balance_dollars !== undefined ? dollarsToCentsFloor(raw.balance_dollars) : typeof raw?.balance === "number" ? raw.balance : 0;
    const byShard = (raw?.balance_breakdown ?? [])
      .filter((b) => typeof b.exchange_index === "number")
      .map((b) => ({ exchangeIndex: b.exchange_index as number, cents: dollarsToCentsFloor(b.balance) }))
      .sort((a, b) => a.exchangeIndex - b.exchangeIndex);
    return { balanceCents, byShard };
  }

  /** Every (subaccount, shard) pair with a balance, the primary (0) included. */
  async subaccountBalances(): Promise<KalshiSubaccountBalance[]> {
    const raw = (await this.call("GET", "/portfolio/subaccounts/balances")) as {
      subaccount_balances?: Array<{ subaccount_number?: number; exchange_index?: number; balance?: string; updated_ts?: number }>;
    } | null;
    return (raw?.subaccount_balances ?? [])
      .filter((b) => typeof b.subaccount_number === "number")
      .map((b) => ({
        subaccount: b.subaccount_number as number,
        exchangeIndex: b.exchange_index ?? 0,
        cents: dollarsToCentsFloor(b.balance),
        updatedTs: b.updated_ts ?? 0,
      }))
      .sort((a, b) => a.subaccount - b.subaccount || a.exchangeIndex - b.exchangeIndex);
  }

  /** Tier, balance and subaccounts in one read, for the operator's page. */
  async snapshot(): Promise<KalshiAccountSnapshot> {
    const [tier, bal, subaccounts] = await Promise.all([this.tier(), this.balance(), this.subaccountBalances()]);
    return { tier, balanceCents: bal.balanceCents, byShard: bal.byShard, subaccounts };
  }

  /**
   * Create the next numbered subaccount, provisioned on one shard. Kalshi numbers them in order
   * (1, 2, ...); to have the same subaccount on a second shard, call again with that shard and
   * Kalshi provisions the existing number there.
   */
  async createSubaccount(exchangeIndex = 0): Promise<{ subaccount: number; exchangeIndex: number }> {
    const raw = (await this.call("POST", "/portfolio/subaccounts", { exchange_index: exchangeIndex })) as { subaccount_number?: number } | null;
    if (typeof raw?.subaccount_number !== "number") throw new Error("kalshi account: create subaccount returned no number");
    return { subaccount: raw.subaccount_number, exchangeIndex };
  }

  /** Move cash between two subaccounts on one shard. Nets to zero at the account; idempotent on the id. */
  async transferBetweenSubaccounts(args: { from: number; to: number; cents: number; exchangeIndex?: number; clientTransferId?: string }): Promise<{ clientTransferId: string }> {
    if (!Number.isInteger(args.cents) || args.cents <= 0) throw new Error("kalshi account: transfer needs a positive whole number of cents");
    if (args.from === args.to) throw new Error("kalshi account: transfer needs two different subaccounts");
    const clientTransferId = args.clientTransferId ?? this.uuid();
    await this.call("POST", "/portfolio/subaccounts/transfer", {
      client_transfer_id: clientTransferId,
      from_subaccount: args.from,
      to_subaccount: args.to,
      amount_cents: args.cents,
      exchange_index: args.exchangeIndex ?? 0,
    });
    return { clientTransferId };
  }

  /**
   * Move the primary account's cash from one shard to another (event contracts only). Kalshi
   * processes it asynchronously; read the balance again to see it land. Amount travels as
   * centicents on the wire.
   */
  async transferBetweenShards(args: { fromShard: number; toShard: number; cents: number; clientTransferId?: string }): Promise<{ transferId: string; clientTransferId: string }> {
    if (!Number.isInteger(args.cents) || args.cents <= 0) throw new Error("kalshi account: transfer needs a positive whole number of cents");
    if (args.fromShard === args.toShard) throw new Error("kalshi account: shard transfer needs two different shards");
    const clientTransferId = args.clientTransferId ?? this.uuid();
    const raw = (await this.call("POST", "/portfolio/intra_exchange_instance_transfer", {
      client_transfer_id: clientTransferId,
      source: "event_contract",
      destination: "event_contract",
      amount: args.cents * 100,
      source_exchange_shard: args.fromShard,
      destination_exchange_shard: args.toShard,
      source_subaccount: 0,
      destination_subaccount: 0,
    })) as { transfer_id?: string } | null;
    return { transferId: raw?.transfer_id ?? "", clientTransferId };
  }

  private async raw(method: string, endpoint: string, body?: unknown): Promise<{ status: number; text: string }> {
    const url = `${this.base}${endpoint}`;
    const path = new URL(url).pathname;
    const ts = this.now();
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "atticus-event-hedge",
      ...kalshiAuthHeaders(this.creds, ts, method, path),
    };
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.timeoutMs) };
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(url, init);
    const text = await res.text().catch(() => "");
    return { status: res.status, text };
  }

  private async call(method: string, endpoint: string, body?: unknown): Promise<unknown> {
    const r = await this.raw(method, endpoint, body);
    if (r.status < 200 || r.status >= 300) throw new KalshiApiError(r.status, method, endpoint, r.text);
    return r.text ? JSON.parse(r.text) : null;
  }
}

function parseTier(raw: {
  usage_tier?: string;
  read?: { refill_rate?: number; bucket_capacity?: number };
  write?: { refill_rate?: number; bucket_capacity?: number };
  grants?: Array<{ exchange_instance?: string; level?: string; source?: string; expires_ts?: number | null }>;
} | null): KalshiTier {
  const usageTier = (raw?.usage_tier ?? "basic").toLowerCase();
  return {
    usageTier,
    read: { refillRate: raw?.read?.refill_rate ?? 0, bucketCapacity: raw?.read?.bucket_capacity ?? 0 },
    write: { refillRate: raw?.write?.refill_rate ?? 0, bucketCapacity: raw?.write?.bucket_capacity ?? 0 },
    grants: (raw?.grants ?? []).map((g) => ({
      exchangeInstance: g.exchange_instance ?? "event_contract",
      level: (g.level ?? "").toLowerCase(),
      source: g.source ?? "",
      expiresTs: typeof g.expires_ts === "number" ? g.expires_ts : null,
    })),
    canCreateSubaccounts: (TIER_RANK[usageTier] ?? 0) >= TIER_RANK.advanced,
  };
}
