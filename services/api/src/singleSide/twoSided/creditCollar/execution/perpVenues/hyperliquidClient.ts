/**
 * Hyperliquid REST client — public info + signed exchange actions. Zero deps beyond the signing
 * module (noble/msgpack). Read paths (mids/meta/state/funding) need no key; order paths sign with
 * HL_PRIVATE_KEY (an API/agent wallet — never the main wallet key).
 *
 * House execution pattern: aggressive IOC limits, never market orders; closes are reduce-only.
 * NOT wired into the running shadow service — consumed by hyperliquidPerpExecutor.
 */

import { signL1Action, addressFromPrivateKey } from "./hyperliquidSigning";

export const HL_MAINNET_BASE = "https://api.hyperliquid.xyz";
export const HL_TESTNET_BASE = "https://api.hyperliquid-testnet.xyz";

export type HlTif = "Gtc" | "Ioc" | "Alo";

export type HlOrderRequest = {
  assetIndex: number;
  isBuy: boolean;
  pxStr: string; // pre-rounded price string (see roundPx)
  szStr: string; // pre-rounded size string (see roundSz)
  reduceOnly: boolean;
  tif: HlTif;
};

export type HlOrderStatus =
  | { kind: "filled"; totalSz: number; avgPx: number; oid: number }
  | { kind: "resting"; oid: number }
  | { kind: "error"; message: string };

export type HlAssetMeta = { name: string; szDecimals: number; maxLeverage: number; assetIndex: number };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type HyperliquidClientConfig = {
  baseUrl?: string; // default mainnet
  privateKeyHex?: string; // required for exchange actions only
  /**
   * The MASTER account address (0x…) when privateKeyHex is an API/agent wallet. Agent keys SIGN on
   * behalf of the master account, but positions/balances live on the master — without this, position
   * queries would look up the agent's own (empty) address. Unset ⟹ the key IS the account.
   */
  masterAddress?: string;
  isMainnet?: boolean; // phantom-agent source; default true unless baseUrl is the testnet
  fetchImpl?: FetchLike; // test seam
  nowMs?: () => number; // nonce source (test seam)
};

/**
 * Perp price rounding: integers always allowed; otherwise max 5 significant figures AND at most
 * (6 − szDecimals) decimal places. Size rounds to szDecimals.
 */
export const roundPx = (px: number, szDecimals: number): string => {
  const maxDecimals = 6 - szDecimals;
  const sig = Number(px.toPrecision(5));
  const dec = Number(sig.toFixed(Math.max(0, maxDecimals)));
  // Integers are always valid regardless of significant figures.
  if (Number.isInteger(px) && px === Math.round(px)) return String(Math.round(px));
  return String(dec);
};

export const roundSz = (sz: number, szDecimals: number): string => String(Number(sz.toFixed(szDecimals)));

export class HyperliquidClient {
  private readonly base: string;
  private readonly key: string | undefined;
  private readonly master: string | undefined;
  private readonly mainnet: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly nowMs: () => number;
  private metaCache: HlAssetMeta[] | null = null;

  constructor(cfg: HyperliquidClientConfig = {}) {
    this.base = cfg.baseUrl ?? HL_MAINNET_BASE;
    this.key = cfg.privateKeyHex;
    this.master = cfg.masterAddress;
    this.mainnet = cfg.isMainnet ?? this.base !== HL_TESTNET_BASE;
    this.fetchImpl = cfg.fetchImpl ?? (fetch as unknown as FetchLike);
    this.nowMs = cfg.nowMs ?? (() => Date.now());
  }

  /** The wallet address for the configured key (agent wallet). */
  address(): string {
    if (!this.key) throw new Error("hyperliquid: no private key configured");
    return addressFromPrivateKey(this.key);
  }

  /** The account that HOLDS positions: the master address when set (agent-key setups), else the key's own. */
  accountAddress(): string {
    return this.master ?? this.address();
  }

  private async post(path: "/info" | "/exchange", body: unknown): Promise<unknown> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`hyperliquid ${path} HTTP ${res.status}`);
    return res.json();
  }

  // ── Public info ─────────────────────────────────────────────────────────────

  async allMids(): Promise<Record<string, string>> {
    return (await this.post("/info", { type: "allMids" })) as Record<string, string>;
  }

  async midPx(coin: string): Promise<number> {
    const mids = await this.allMids();
    const px = Number(mids[coin]);
    if (!Number.isFinite(px) || px <= 0) throw new Error(`hyperliquid: no mid for ${coin}`);
    return px;
  }

  async meta(): Promise<HlAssetMeta[]> {
    if (this.metaCache) return this.metaCache;
    const raw = (await this.post("/info", { type: "meta" })) as { universe: Array<{ name: string; szDecimals: number; maxLeverage: number }> };
    this.metaCache = raw.universe.map((u, i) => ({ name: u.name, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage, assetIndex: i }));
    return this.metaCache;
  }

  async assetMeta(coin: string): Promise<HlAssetMeta> {
    const m = (await this.meta()).find((a) => a.name === coin);
    if (!m) throw new Error(`hyperliquid: unknown coin ${coin}`);
    return m;
  }

  /** Signed position size for the given address+coin (+long/−short/0). */
  async positionSz(address: string, coin: string): Promise<number> {
    const st = (await this.post("/info", { type: "clearinghouseState", user: address })) as {
      assetPositions?: Array<{ position: { coin: string; szi: string } }>;
    };
    const p = (st.assetPositions ?? []).find((ap) => ap.position.coin === coin);
    return p ? Number(p.position.szi) : 0;
  }

  /** Current funding in bps per 8h from metaAndAssetCtxs (funding is an 8h rate fraction). */
  async fundingBpsPer8h(coin: string): Promise<number | null> {
    const raw = (await this.post("/info", { type: "metaAndAssetCtxs" })) as [
      { universe: Array<{ name: string }> },
      Array<{ funding: string }>
    ];
    const idx = raw[0].universe.findIndex((u) => u.name === coin);
    if (idx < 0 || !raw[1][idx]) return null;
    const f = Number(raw[1][idx].funding);
    return Number.isFinite(f) ? +(f * 10_000).toFixed(4) : null;
  }

  // ── Signed exchange actions ─────────────────────────────────────────────────

  async placeOrder(req: HlOrderRequest): Promise<HlOrderStatus> {
    if (!this.key) throw new Error("hyperliquid: no private key configured");
    // Field order matters — the server hashes the msgpack bytes exactly as sent.
    const action = {
      type: "order",
      orders: [{ a: req.assetIndex, b: req.isBuy, p: req.pxStr, s: req.szStr, r: req.reduceOnly, t: { limit: { tif: req.tif } } }],
      grouping: "na"
    };
    const nonce = this.nowMs();
    const signature = signL1Action(action, nonce, this.key, this.mainnet);
    const raw = (await this.post("/exchange", { action, nonce, signature })) as {
      status: string;
      response?: { type: string; data?: { statuses?: Array<Record<string, unknown>> } };
    };
    if (raw.status !== "ok") return { kind: "error", message: JSON.stringify(raw) };
    const st = raw.response?.data?.statuses?.[0] ?? {};
    if ("filled" in st) {
      const f = st.filled as { totalSz: string; avgPx: string; oid: number };
      return { kind: "filled", totalSz: Number(f.totalSz), avgPx: Number(f.avgPx), oid: f.oid };
    }
    if ("resting" in st) return { kind: "resting", oid: (st.resting as { oid: number }).oid };
    if ("error" in st) return { kind: "error", message: String(st.error) };
    return { kind: "error", message: `unrecognized status: ${JSON.stringify(st)}` };
  }

  async cancelOrder(assetIndex: number, oid: number): Promise<boolean> {
    if (!this.key) throw new Error("hyperliquid: no private key configured");
    const action = { type: "cancel", cancels: [{ a: assetIndex, o: oid }] };
    const nonce = this.nowMs();
    const signature = signL1Action(action, nonce, this.key, this.mainnet);
    const raw = (await this.post("/exchange", { action, nonce, signature })) as { status: string };
    return raw.status === "ok";
  }
}
