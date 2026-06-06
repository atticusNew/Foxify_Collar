/**
 * Shared API layer for the two-sided cooperative-volume dashboards.
 *
 * TWO independent token gates, stored under SEPARATE localStorage keys so the
 * Foxify-facing view and the Atticus operator view never share a credential:
 *   - Foxify view (/cover)        → X-Foxify-Token  (ts_foxify_token)
 *   - Atticus view (/cover/admin) → X-Admin-Token   (ts_admin_token)
 *
 * The Foxify view ONLY ever calls /foxify/v2/* (which require the Foxify token);
 * the Atticus view calls /admin/foxify/v2/*. The server enforces the boundary —
 * a Foxify token cannot reach an admin endpoint — so the UI cannot leak internals.
 */

import { API_BASE } from "../config";

export const FOXIFY_TOKEN_KEY = "ts_foxify_token";
export const ADMIN_TOKEN_KEY = "ts_admin_token";
export const DEMO_TOKEN_KEY = "ts_demo_token";

export type Role = "foxify" | "admin" | "demo";

const HEADER_FOR: Record<Role, string> = {
  foxify: "X-Foxify-Token",
  admin: "X-Admin-Token",
  demo: "X-Demo-Token"
};
const KEY_FOR: Record<Role, string> = {
  foxify: FOXIFY_TOKEN_KEY,
  admin: ADMIN_TOKEN_KEY,
  demo: DEMO_TOKEN_KEY
};

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export const getToken = (role: Role): string | null => localStorage.getItem(KEY_FOR[role]);
export const setToken = (role: Role, token: string): void => localStorage.setItem(KEY_FOR[role], token.trim());
export const clearToken = (role: Role): void => localStorage.removeItem(KEY_FOR[role]);

const request = async <T>(role: Role, path: string, init: RequestInit = {}): Promise<T> => {
  const token = getToken(role);
  if (!token) throw new UnauthorizedError();
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      [HEADER_FOR[role]]: token,
      "Content-Type": "application/json",
      ...(init.headers ?? {})
    }
  });
  if (r.status === 401) {
    clearToken(role);
    throw new UnauthorizedError();
  }
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try {
      const body = await r.json();
      if (body?.message || body?.error) detail = `${body.error ?? ""} ${body.message ?? ""}`.trim();
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail);
  }
  // 204 / empty
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
};

export const foxifyGet = <T>(path: string): Promise<T> => request<T>("foxify", path);
export const foxifyPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>("foxify", path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) });

export const demoGet = <T>(path: string): Promise<T> => request<T>("demo", path);
export const demoPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>("demo", path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) });

/** Ungated public GET (no token) for the public-safe demo endpoints (/public/*). */
export const publicGet = async <T>(path: string): Promise<T> => {
  const r = await fetch(`${API_BASE}${path}`, { headers: { "Content-Type": "application/json" } });
  if (!r.ok) {
    let detail = `${r.status} ${r.statusText}`;
    try { const b = await r.json(); if (b?.message || b?.error) detail = `${b.error ?? ""} ${b.message ?? ""}`.trim(); } catch { /* non-JSON */ }
    throw new Error(detail);
  }
  const text = await r.text();
  return (text ? JSON.parse(text) : {}) as T;
};

export const adminGet = <T>(path: string): Promise<T> => request<T>("admin", path);
export const adminPost = <T>(path: string, body?: unknown): Promise<T> =>
  request<T>("admin", path, { method: "POST", body: body == null ? undefined : JSON.stringify(body) });

/** Fetch several endpoints in parallel; per-key errors are captured, not thrown,
 *  so one failing panel never blanks the whole dashboard. */
export const settleAll = async <T extends Record<string, Promise<unknown>>>(
  reqs: T
): Promise<{ [K in keyof T]: Awaited<T[K]> | null } & { __errors: Partial<Record<keyof T, string>> }> => {
  const keys = Object.keys(reqs) as (keyof T)[];
  const results = await Promise.allSettled(keys.map((k) => reqs[k]));
  // Build with a loose accumulator, then cast to the precise mapped type at return —
  // TS can't narrow per-key index assignment through the mapped type otherwise.
  const out: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  keys.forEach((k, i) => {
    const res = results[i];
    if (res.status === "fulfilled") {
      out[k as string] = res.value;
    } else {
      out[k as string] = null;
      errors[k as string] = (res.reason as Error) instanceof UnauthorizedError ? "unauthorized" : ((res.reason as Error)?.message ?? "error");
    }
  });
  out.__errors = errors;
  return out as { [K in keyof T]: Awaited<T[K]> | null } & { __errors: Partial<Record<keyof T, string>> };
};
