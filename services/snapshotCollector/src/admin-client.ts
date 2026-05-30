import {
  ActivePositionsDetailResponseSchema,
  AllOpenLegsResponseSchema,
  DashboardResponseSchema,
  HealthResponseSchema,
  HedgeManagerDryRunResponseSchema,
  PoolLedgerResponseSchema,
  type ActivePositionsDetailResponse,
  type AllOpenLegsResponse,
  type DashboardResponse,
  type EndpointKind,
  type HealthResponse,
  type HedgeManagerDryRunResponse,
  type PoolLedgerResponse
} from "./types.js";

export type FetchResult<T> = {
  endpoint: EndpointKind;
  url: string;
  httpStatus: number;
  ok: boolean;
  rawBody: unknown;
  parsed: T | null;
  errorMessage: string | null;
};

export type AdminClientConfig = {
  baseUrl: string;
  adminToken: string;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 15_000;

const fetchWithTimeout = async (
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const adminGet = async <T>(
  cfg: AdminClientConfig,
  endpoint: EndpointKind,
  path: string,
  parser: (raw: unknown) => T
): Promise<FetchResult<T>> => {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          "X-Admin-Token": cfg.adminToken,
          "Accept": "application/json"
        }
      },
      timeoutMs
    );
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        endpoint,
        url,
        httpStatus: res.status,
        ok: false,
        rawBody: body,
        parsed: null,
        errorMessage: `http_${res.status}`
      };
    }
    let parsed: T | null = null;
    let errorMessage: string | null = null;
    try {
      parsed = parser(body);
    } catch (err) {
      errorMessage = `schema_mismatch:${(err as Error).message}`;
    }
    return {
      endpoint,
      url,
      httpStatus: res.status,
      ok: true,
      rawBody: body,
      parsed,
      errorMessage
    };
  } catch (err) {
    return {
      endpoint,
      url,
      httpStatus: 0,
      ok: false,
      rawBody: null,
      parsed: null,
      errorMessage: `fetch_error:${(err as Error).message}`
    };
  }
};

const adminPost = async <T>(
  cfg: AdminClientConfig,
  endpoint: EndpointKind,
  path: string,
  body: Record<string, unknown> | null,
  parser: (raw: unknown) => T
): Promise<FetchResult<T>> => {
  const url = `${cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          "X-Admin-Token": cfg.adminToken,
          "Accept": "application/json",
          "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : "{}"
      },
      timeoutMs
    );
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        endpoint,
        url,
        httpStatus: res.status,
        ok: false,
        rawBody: respBody,
        parsed: null,
        errorMessage: `http_${res.status}`
      };
    }
    let parsed: T | null = null;
    let errorMessage: string | null = null;
    try {
      parsed = parser(respBody);
    } catch (err) {
      errorMessage = `schema_mismatch:${(err as Error).message}`;
    }
    return {
      endpoint,
      url,
      httpStatus: res.status,
      ok: true,
      rawBody: respBody,
      parsed,
      errorMessage
    };
  } catch (err) {
    return {
      endpoint,
      url,
      httpStatus: 0,
      ok: false,
      rawBody: null,
      parsed: null,
      errorMessage: `fetch_error:${(err as Error).message}`
    };
  }
};

export const fetchHealth = (cfg: AdminClientConfig): Promise<FetchResult<HealthResponse>> =>
  adminGet(cfg, "health", "/volume-cover/health", (raw) => HealthResponseSchema.parse(raw));

export const fetchDashboard = (cfg: AdminClientConfig): Promise<FetchResult<DashboardResponse>> =>
  adminGet(cfg, "dashboard", "/volume-cover/admin/dashboard", (raw) =>
    DashboardResponseSchema.parse(raw)
  );

export const fetchActivePositionsDetail = (
  cfg: AdminClientConfig,
  limit = 200
): Promise<FetchResult<ActivePositionsDetailResponse>> =>
  adminGet(
    cfg,
    "active-positions-detail",
    `/volume-cover/admin/active-positions-detail?limit=${limit}`,
    (raw) => ActivePositionsDetailResponseSchema.parse(raw)
  );

export const fetchAllOpenLegs = (cfg: AdminClientConfig): Promise<FetchResult<AllOpenLegsResponse>> =>
  adminGet(cfg, "all-open-legs", "/volume-cover/admin/all-open-legs", (raw) =>
    AllOpenLegsResponseSchema.parse(raw)
  );

export const fetchPoolLedger = (
  cfg: AdminClientConfig,
  poolId: "atticus_hedge" | "foxify_trader",
  limit = 500
): Promise<FetchResult<PoolLedgerResponse>> =>
  adminGet(
    cfg,
    poolId === "atticus_hedge" ? "pool-ledger-atticus" : "pool-ledger-foxify",
    `/volume-cover/admin/pool-ledger?poolId=${poolId}&limit=${limit}`,
    (raw) => PoolLedgerResponseSchema.parse(raw)
  );

export const fetchHedgeManagerDryRun = (
  cfg: AdminClientConfig,
  iv = 0.4
): Promise<FetchResult<HedgeManagerDryRunResponse>> =>
  adminPost(
    cfg,
    "hedge-manager-dry-run",
    `/volume-cover/admin/hedge-manager/run?dryRun=true&iv=${iv}`,
    null,
    (raw) => HedgeManagerDryRunResponseSchema.parse(raw)
  );
