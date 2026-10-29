/**
 * NOVIG ACCOUNT: the subaccount a trading key addresses, opened, funded and read with the
 * management key. Nothing here places an order.
 *
 * Why this exists: on this venue no key both moves money and places orders. The management key
 * (made once on the venue's profile page) opens subaccounts, funds them and reads every wallet;
 * it cannot order. Orders come only from a `trading` key, and a trading key reaches exactly one
 * subaccount. So before the service can send an order to this venue (a hedge on the holder's own
 * venue, once that route is built) it needs a subaccount of its own: opened here with a fresh
 * keypair whose private half becomes the service's trading key, funded from the cash wallet, and
 * checked. The holder's own plays stay in the cash wallet and are read as before
 * (venuePositions.ts); the management key reads both.
 *
 * Wire (docs.novig.com, API v3), all signed NOVIG-V3 (venuePositions.ts) with the management key:
 *   POST /v3/account/subaccounts {label, publicKey (SPKI PEM), algorithm, expiresAt?}
 *        -> 201 {keyId, label, balance}; keyId is the new trading key AND the subaccount's address.
 *           One trading key per subaccount; up to 10 live subaccounts; KYC must be passed.
 *   GET  /v3/account/subaccounts                       -> [{keyId, label, balance}] (live ones)
 *   GET  /v3/account/subaccounts/{keyId}/balance        -> {balance}
 *   POST /v3/account/subaccounts/{keyId}/transfer {direction: fund|defund, amount, clientTransferId}
 *        -> 202 {transferId, status: Requested|Applied|Rejected, ...}; 202 is accepted, not moved
 *   GET  /v3/account/subaccounts/{keyId}/transfers/{id} -> the transfer with its status
 *
 * Money is a decimal string with exactly five places ("250.00000"); cents here, converted both
 * ways without rounding. Location checks apply to every signed route (a data-centre address is
 * fine; a VPN or a restricted state is a 451), and a placement also needs a device geolocation
 * from the key holder's app within the last 3 days. The partner is never named in anything the
 * record publishes; this module is operator tooling.
 */

import { generateKeyPairSync } from "node:crypto";
import { VenueApiError, signedHeaders, type VenueSigner } from "./venuePositions";

export type NovigAlgorithm = "Ed25519" | "P-256";
export type TransferDirection = "fund" | "defund";
export type TransferStatus = "Requested" | "Applied" | "Rejected";

export interface NovigSubaccount {
  /** the trading key id, and the address every subaccount route takes */
  keyId: string;
  label: string;
  balanceCents: number;
  /** the venue's own figure, five places */
  balance: string;
}

export interface NovigTransfer {
  transferId: string;
  status: TransferStatus;
  direction: TransferDirection;
  amountCents: number;
  /** on a Rejected transfer, the balance the venue found; else null */
  actualBalanceCents: number | null;
  clientTransferId: string | null;
  createdAt: string | null;
}

export interface OpenSubaccountInput {
  label: string;
  /** SPKI PEM of a fresh keypair; the venue stores only this half */
  publicKeyPem: string;
  algorithm: NovigAlgorithm;
  /** ISO date-time strictly in the future; omitted, the key does not expire */
  expiresAt?: string;
}

export interface FundInput {
  direction: TransferDirection;
  amountCents: number;
  /** the idempotency key, up to 64 characters, unique per trader; a retry with the same id returns the first answer */
  clientTransferId: string;
}

// ---------------------------------------------------------------------------
// money
// ---------------------------------------------------------------------------

/** "1234.50000" -> 123450. Exact: the venue's five places are read, never rounded through a float. */
export function decimal5ToCents(s: string): number {
  const m = /^(-)?(\d+)(?:\.(\d{1,5}))?$/.exec(String(s).trim());
  if (!m) throw new Error(`novig account: not a decimal amount: ${JSON.stringify(s)}`);
  const whole = Number(m[2]);
  const frac = (m[3] ?? "").padEnd(5, "0");
  const cents = whole * 100 + Number(frac.slice(0, 2));
  return m[1] ? -cents : cents;
}

/** 25000 -> "250.00000": the five places the venue requires, cents to the dollar exactly. */
export function centsToDecimal5(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`novig account: cents must be a non-negative integer, got ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}000`;
}

// ---------------------------------------------------------------------------
// keys and bodies (pure)
// ---------------------------------------------------------------------------

/** A fresh Ed25519 keypair: the public half goes to the venue, the private half becomes the trading key. */
export function mintTradingKeypair(): { publicKeyPem: string; privateKeyPem: string; algorithm: NovigAlgorithm } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    algorithm: "Ed25519",
  };
}

export function openSubaccountBody(i: OpenSubaccountInput): Record<string, string> {
  const label = i.label.trim();
  if (!label || label.length > 64) throw new Error("novig account: label is 1 to 64 characters");
  if (!/^-----BEGIN PUBLIC KEY-----/.test(i.publicKeyPem.trim())) throw new Error("novig account: publicKey must be an SPKI PEM");
  const body: Record<string, string> = { label, publicKey: i.publicKeyPem, algorithm: i.algorithm };
  if (i.expiresAt) body.expiresAt = i.expiresAt;
  return body;
}

export function fundBody(i: FundInput): { direction: TransferDirection; amount: string; clientTransferId: string } {
  if (i.amountCents <= 0) throw new Error("novig account: a transfer moves a positive amount");
  const id = i.clientTransferId.trim();
  if (!id || id.length > 64) throw new Error("novig account: clientTransferId is 1 to 64 characters");
  return { direction: i.direction, amount: centsToDecimal5(i.amountCents), clientTransferId: id };
}

export function parseSubaccount(raw: unknown): NovigSubaccount {
  const r = (raw ?? {}) as { keyId?: unknown; label?: unknown; balance?: unknown };
  if (typeof r.keyId !== "string" || !r.keyId) throw new Error("novig account: subaccount without keyId");
  const balance = typeof r.balance === "string" ? r.balance : "0.00000";
  return { keyId: r.keyId, label: typeof r.label === "string" ? r.label : "", balance, balanceCents: decimal5ToCents(balance) };
}

export function parseTransfer(raw: unknown): NovigTransfer {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (typeof r.transferId !== "string" || !r.transferId) throw new Error("novig account: transfer without transferId");
  const status = r.status === "Applied" || r.status === "Rejected" ? r.status : "Requested";
  return {
    transferId: r.transferId,
    status,
    direction: r.direction === "defund" ? "defund" : "fund",
    amountCents: typeof r.amount === "string" ? decimal5ToCents(r.amount) : 0,
    actualBalanceCents: typeof r.actualBalance === "string" ? decimal5ToCents(r.actualBalance) : null,
    clientTransferId: typeof r.clientTransferId === "string" ? r.clientTransferId : null,
    createdAt: typeof r.createdAt === "string" ? r.createdAt : null,
  };
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export interface NovigAccountClientConfig {
  host: string;
  /** the management key: the only key that opens and funds */
  signer: VenueSigner;
  fetchImpl?: typeof fetch;
}

export class NovigAccountClient {
  private readonly fetchImpl: typeof fetch;
  private readonly host: string;

  constructor(private readonly cfg: NovigAccountClientConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.host = cfg.host.replace(/\/+$/, "");
  }

  private async call<T>(method: "GET" | "POST" | "PATCH", path: string, body?: unknown): Promise<T> {
    const raw = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(raw ? { "content-type": "application/json" } : {}),
      ...signedHeaders(this.cfg.signer, { method, path, query: "", body: raw }),
    };
    const r = await this.fetchImpl(`${this.host}${path}`, { method, headers, ...(raw ? { body: raw } : {}) });
    const text = await r.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!r.ok) {
      const b = (json ?? {}) as { code?: string; message?: string };
      throw new VenueApiError(r.status, b.code ?? `http_${r.status}`, b.message ?? `venue api ${r.status} on ${path}`);
    }
    return json as T;
  }

  /** Opens the subaccount, its wallet and its one trading key in one call. The answer's keyId is the trading key id. */
  async openSubaccount(i: OpenSubaccountInput): Promise<NovigSubaccount> {
    return parseSubaccount(await this.call("POST", "/v3/account/subaccounts", openSubaccountBody(i)));
  }

  /** One row per live subaccount; each row's keyId is that subaccount's trading key. */
  async listSubaccounts(): Promise<NovigSubaccount[]> {
    const rows = await this.call<unknown>("GET", "/v3/account/subaccounts");
    return (Array.isArray(rows) ? rows : []).map(parseSubaccount);
  }

  async balance(keyId: string): Promise<{ balance: string; balanceCents: number }> {
    const r = await this.call<{ balance?: string }>("GET", `/v3/account/subaccounts/${encodeURIComponent(keyId)}/balance`);
    const balance = typeof r?.balance === "string" ? r.balance : "0.00000";
    return { balance, balanceCents: decimal5ToCents(balance) };
  }

  /** Change the display label; the one thing about a subaccount that can change. */
  async relabel(keyId: string, label: string): Promise<NovigSubaccount> {
    return parseSubaccount(await this.call("PATCH", `/v3/account/subaccounts/${encodeURIComponent(keyId)}`, { label }));
  }

  /**
   * Move cash between the cash wallet and the subaccount. A 202 is accepted, not moved: read the
   * transfer back (`transfer`, `waitApplied`) before treating the money as there.
   */
  async fund(keyId: string, i: FundInput): Promise<NovigTransfer> {
    return parseTransfer(await this.call("POST", `/v3/account/subaccounts/${encodeURIComponent(keyId)}/transfer`, fundBody(i)));
  }

  async transfer(keyId: string, transferId: string): Promise<NovigTransfer> {
    return parseTransfer(await this.call("GET", `/v3/account/subaccounts/${encodeURIComponent(keyId)}/transfers/${encodeURIComponent(transferId)}`));
  }

  /**
   * Poll a transfer until it is final. A transfer that stays Requested is the venue's to resolve
   * (its docs: contact support, never retry under a new id), so this returns it as it stands.
   */
  async waitApplied(keyId: string, transferId: string, opts: { tries?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<NovigTransfer> {
    const tries = opts.tries ?? 10;
    const delayMs = opts.delayMs ?? 1000;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let last = await this.transfer(keyId, transferId);
    for (let i = 1; i < tries && last.status === "Requested"; i++) {
      await sleep(delayMs);
      last = await this.transfer(keyId, transferId);
    }
    return last;
  }
}

/** The service env a trading key is handed over as, once the operator has opened the subaccount. */
export const NOVIG_TRADE_ENV = { keyId: "NOVIG_TRADE_KEY_ID", pem: "NOVIG_TRADE_PRIVATE_KEY_PEM", host: "VENUE_API_HOST" } as const;
