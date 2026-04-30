import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type ReferencePrice = { price: string; marketId: string; venue: string; source: string; timestamp: string; ageMs: number };
type V7Info = {
  regime: string;
  regimeSource: string;
  dvol: number | null;
  premiumPer1kUsd: number;
  premiumUsd: number;
  payoutPer10kUsd: number;
  available: boolean;
  // Design A — pricing regime (low / moderate / elevated / high) and
  // its human-friendly label ("Low" / "Moderate" / "Elevated" / "High").
  // Optional for backwards compatibility with quotes generated before
  // Design A deploys.
  pricingRegime?: "low" | "moderate" | "elevated" | "high";
  pricingRegimeLabel?: string;
};

// Biweekly quote response shape (PR 5 of biweekly cutover, 2026-04-30).
// Returned by the server when the request body included product:"biweekly".
// All fields per services/api/src/pilot/biweeklyActivate.ts
// BiweeklyQuoteResponse type.
type BiweeklyQuoteResponse = {
  status: "ok";
  product: "biweekly";
  quoteId: string;
  ratePerDayPer1kUsd: number;
  ratePerDayUsd: number;
  maxTenorDays: number;
  maxProjectedChargeUsd: number;
  payoutOnTriggerUsd: number;
  triggerPriceUsd: number;
  strikeHintUsd: number;
  hedgeQuote: { venueQuoteId: string; instrumentId: string; venuePremiumBtc: number; venuePremiumUsd: number; expiresAt: string };
};

type QuoteResponse = { status: string; protectionType: string; tierName: string; slPct: number | null; drawdownFloorPct: string; triggerPrice: string; floorPrice: string; v7: V7Info | null; quote: { quoteId: string; instrumentId: string; premium: number; expiresAt: string; side: string; quantity: number; venue: string; details?: Record<string, unknown> }; entrySnapshot: { price: string; marketId: string; source: string; timestamp: string } };

// Extended ProtectionRecord — biweekly fields (added in PR 2 of cutover)
// are optional so legacy 1-day rows still type-check. Fields default to
// 1-day legacy semantics on the server side.
type ProtectionRecord = {
  id: string;
  status: string;
  tierName: string;
  protectedNotional: string;
  entryPrice: string;
  floorPrice: string;
  drawdownFloorPct: string;
  expiryAt: string;
  premium: string;
  autoRenew: boolean;
  payoutDueAmount: string | null;
  payoutSettledAmount: string | null;
  venue: string;
  instrumentId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  // Biweekly subscription fields (server returns these on every protection;
  // legacy 1-day rows have tenorDays=1 and the rest null/0/false).
  tenorDays?: number;
  dailyRateUsdPer1k?: string | null;
  accumulatedChargeUsd?: string;
  daysBilled?: number;
  closedAt?: string | null;
  closedBy?: string | null;
  hedgeRetainedForPlatform?: boolean;
};

type MonitorResponse = { status: string; protection?: ProtectionRecord & { renewedTo?: string | null; archivedAt?: string | null }; currentPrice?: string; distanceToFloor?: { pct: string; usd: string; direction: string }; timeRemaining?: { ms: number; human: string } };

// Local Position cache. Adds optional biweekly fields:
//   - dailyRateUsd: trader-facing $/day on this position (rate × notional/1000)
//   - maxProjectedCharge: max if held to expiry
//   - tenorDays: 1 (legacy) or 14 (biweekly)
//   - activatedAtMs: for client-side "day N of 14" computation
//
// premium retained for legacy 1-day rendering. For biweekly rows it's
// the running accumulated charge (refreshed from server on each monitor
// poll if available).
type Position = {
  id: string;
  num: number;
  type: "long" | "short";
  size: number;
  stopLoss: number;
  entryPrice: number;
  protectionId: string | null;
  autoRenew: boolean;
  premium: number;
  status: "active" | "closed" | "triggered";
  closedPnl: number | null;
  closedPayout: number | null;
  // Biweekly fields (optional; null/undefined for legacy 1-day rows)
  tenorDays?: number;
  dailyRateUsd?: number;
  maxProjectedCharge?: number;
  activatedAtMs?: number;
};

// ─── Config ──────────────────────────────────────────────────────────

const STOP_LOSS_OPTIONS = [2, 3, 5, 10] as const;
type StopLoss = (typeof STOP_LOSS_OPTIONS)[number];
const STOP_LOSS_TO_TIER: Record<StopLoss, string> = { 2: "SL 2%", 3: "SL 3%", 5: "SL 5%", 10: "SL 10%" };

// Biweekly per-day rate preview (PR 5 of biweekly cutover, 2026-04-30).
// USD per $1k notional per day. Mirrors the BIWEEKLY_DEFAULT_RATES table
// in services/api/src/pilot/biweeklyPricing.ts so the widget can
// render the rate immediately, before the server quote round-trip.
//
// CEO direction 2026-04-30: "$2.50 for 2-3%, $2.00 for 5%, $1.50 for 10%
// flat across regimes — the absolute baseline." Server may override these
// via PILOT_BIWEEKLY_RATE_<N>PCT env; if so the server-returned rate
// (in BiweeklyQuoteResponse.ratePerDayPer1kUsd) is authoritative.
const BIWEEKLY_RATE_PER_1K_DAY: Record<StopLoss, number> = { 2: 2.5, 3: 2.5, 5: 2.0, 10: 1.5 };
const BIWEEKLY_MAX_TENOR_DAYS = 14;

// Legacy 1-day rate table — retained for back-compat rendering of the 2
// existing 1-day protections that are still active at biweekly cutover
// time. After they expire (~24h post-deploy), this table is dead UI; PR 6
// removes it.
const SL_RATE: Record<StopLoss, number> = { 2: 6.5, 3: 5, 5: 3, 10: 2 };
const SL_TENOR: Record<StopLoss, number> = { 2: 1, 3: 1, 5: 1, 10: 1 };
const POS_MIN = 10000, POS_MAX = 50000, POS_STEP = 5000, INIT_BAL = 1_000_000;
const K_BAL = "foxify_pilot_balance", K_SET = "foxify_pilot_settlement", K_POS = "foxify_pilot_positions", K_NUM = "foxify_pilot_posnum";
const LOGO = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";

// ─── Helpers ─────────────────────────────────────────────────────────

const fmt = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtWhole = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fTime = (ms: number): string => { if (ms <= 0) return "Expired"; const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`; };

// ─── API ─────────────────────────────────────────────────────────────

const api = async <T = unknown>(p: string, o?: RequestInit): Promise<T> => {
  const r = await fetch(`${API_BASE}${p}`, { ...o, headers: { "Content-Type": "application/json", ...o?.headers } });
  let j: any;
  try { j = await r.json(); } catch { throw new Error(r.ok ? "invalid_response" : `HTTP ${r.status}`); }
  // Prefer the server's user-facing `message` over the machine `reason` code
  // so cap-exceeded / quote-expired / etc render in plain language. Fall
  // back to reason if message is missing (older endpoints), then HTTP code.
  if (!r.ok) throw new Error(j?.message || j?.reason || `HTTP ${r.status}`);
  return j as T;
};
const fetchRef = () => api<{ status: string; reference: ReferencePrice }>("/pilot/reference-price");

// Design A — poll the pricing regime so the widget can show a live
// "Volatility: Low/Moderate/Elevated/High" label even before the user
// requests a quote, AND so the client-side premium preview uses the
// correct schedule for the day's regime.
type RegimeInfo = {
  status: string;
  pricingRegime?: "low" | "moderate" | "elevated" | "high";
  pricingRegimeLabel?: string;
  tiers?: Array<{ slPct: number; premiumPer1kUsd: number }>;
};
const fetchRegime = () => api<RegimeInfo>("/pilot/regime");
const fetchQuote = (b: Record<string, unknown>) => api<QuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify(b) });
// Biweekly quote (PR 3 of cutover). Server detects product:"biweekly"
// in the body and returns BiweeklyQuoteResponse instead of the legacy
// QuoteResponse shape.
const fetchBiweeklyQuote = (b: Record<string, unknown>) =>
  api<BiweeklyQuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify({ ...b, product: "biweekly" }) });
const activateProt = (b: Record<string, unknown>) => api<{ status: string; protectionId: string; protection: ProtectionRecord }>("/pilot/protections/activate", { method: "POST", body: JSON.stringify(b) });
// Biweekly activate. Same /activate endpoint, server dispatches based on
// product:"biweekly". Returns the biweekly-shaped response with ok status
// + product:"biweekly" + protection.
const activateBiweeklyProt = (b: Record<string, unknown>) =>
  api<{ status: "ok"; product: "biweekly"; protection: ProtectionRecord }>(
    "/pilot/protections/activate",
    { method: "POST", body: JSON.stringify({ ...b, product: "biweekly" }) }
  );
// Close a biweekly subscription (PR 4 of cutover). Server settles
// accumulated charge through close-time and ends the subscription.
// Returns the updated protection + bill amount for the toast.
const closeBiweeklyProt = (id: string) =>
  api<{
    status: "ok";
    product: "biweekly";
    protection: ProtectionRecord;
    accumulatedChargeUsd: number;
    daysBilled: number;
    hedgeRetainedForPlatform: boolean;
    newlyClosed: boolean;
  }>(`/pilot/protections/${id}/close`, { method: "POST", body: JSON.stringify({}) });

const fetchMon = async (id: string): Promise<MonitorResponse> => {
  const raw = await api<{ status: string; monitor?: MonitorResponse } & MonitorResponse>(`/pilot/protections/${id}/monitor`);
  return raw.monitor || raw;
};
const toggleAutoRenew = (id: string, enabled: boolean) =>
  api<{ status: string; autoRenew: boolean; protection?: ProtectionRecord; idempotentReplay?: boolean; message?: string }>(
    `/pilot/protections/${id}/auto-renew`,
    { method: "POST", body: JSON.stringify({ enabled }) }
  );

// Helper to identify biweekly positions for branching display logic.
// A position is biweekly if tenorDays >= 2. Defaults to legacy (false)
// when tenorDays is missing.
const isBiweeklyPosition = (pos: Position): boolean => (pos.tenorDays ?? 1) >= 2;

// Helper to compute days held client-side (for the running tally on
// active biweekly positions). Mirrors the server's day-boundary grace
// behavior crudely — Math.max(1, Math.ceil(elapsed)) — clamped to
// BIWEEKLY_MAX_TENOR_DAYS. The authoritative number on close comes
// from the server. This is just for display.
const biweeklyDaysHeldDisplay = (activatedAtMs: number, nowMs: number = Date.now()): number => {
  const elapsedMs = Math.max(0, nowMs - activatedAtMs);
  const days = elapsedMs / 86400000;
  return Math.min(BIWEEKLY_MAX_TENOR_DAYS, Math.max(1, Math.ceil(days)));
};

// ─── Persistence ─────────────────────────────────────────────────────

type Settl = { totalPremiums: number; totalPayouts: number };
const ld = <T,>(k: string, f: T): T => {
  try {
    const v = localStorage.getItem(k);
    if (!v) return f;
    const parsed = JSON.parse(v);
    if (typeof f === "number" && (typeof parsed !== "number" || !Number.isFinite(parsed))) return f;
    if (Array.isArray(f) && !Array.isArray(parsed)) return f;
    return parsed;
  } catch { return f; }
};
const sv = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ─── Section ─────────────────────────────────────────────────────────

function Section({ title, badge, open, onToggle, children }: { title: string; badge?: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div className="section">
      <button onClick={onToggle} style={{ width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "0 0 8px 0", border: "none", background: "none", cursor: "pointer", color: "var(--text)" }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{title}{badge && <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 400, marginLeft: 6 }}>{badge}</span>}</span>
        <span style={{ fontSize: 12, color: "var(--muted)", transition: "transform 0.2s", transform: open ? "rotate(180deg)" : "rotate(0deg)" }}>▼</span>
      </button>
      {open && children}
    </div>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  useEffect(() => { const t = setTimeout(() => onDoneRef.current(), 3500); return () => clearTimeout(t); }, []);
  return (
    <div style={{ padding: "10px 14px", marginBottom: 12, borderRadius: 8, background: "rgba(54,211,141,0.12)", border: "1px solid rgba(54,211,141,0.25)", color: "var(--success)", fontSize: 13, fontWeight: 500, animation: "fadeIn 0.2s ease" }}>
      {message}
    </div>
  );
}

// ─── Widget ──────────────────────────────────────────────────────────

export function PilotWidget() {
  const [positionType, setPositionType] = useState<"long" | "short" | null>(null);
  const [positionSize, setPositionSize] = useState(10000);
  const [stopLoss, setStopLoss] = useState<StopLoss | null>(null);
  // autoRenew form-level state retained for legacy 1-day code paths
  // that still reference Position.autoRenew. Biweekly does not use
  // auto-renew (per design decision; trader explicitly opens new
  // subscription at end). The form-level checkbox was removed in PR 5.
  const [autoRenew, setAutoRenew] = useState(false);
  void autoRenew; void setAutoRenew;
  const [livePrice, setLivePrice] = useState<number | null>(null);
  // Design A — current pricing regime + per-tier rates from server.
  // Falls back to client-side SL_RATE table only if the server poll
  // hasn't returned yet (first paint).
  const [regimeInfo, setRegimeInfo] = useState<RegimeInfo | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceTs, setPriceTs] = useState(0);
  const [positions, setPositions] = useState<Position[]>(() => ld(K_POS, []));
  const [activating, setActivating] = useState(false);
  const [protectingPosId, setProtectingPosId] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
  const [autoRenewToggling, setAutoRenewToggling] = useState<string | null>(null);
  const [balance, setBalance] = useState(() => ld(K_BAL, INIT_BAL) as number);
  const [settlement, setSettlement] = useState<Settl>(() => ld(K_SET, { totalPremiums: 0, totalPayouts: 0 }));
  const [monitors, setMonitors] = useState<Record<string, MonitorResponse>>({});
  const [toast, setToast] = useState<string | null>(null);
  const [posOpen, setPosOpen] = useState(false);
  const [closedOpen, setClosedOpen] = useState(false);
  const [settlOpen, setSettlOpen] = useState(false);
  const posNumRef = useRef(ld(K_NUM, 0) as number);

  useEffect(() => { sv(K_POS, positions); }, [positions]);
  useEffect(() => { sv(K_BAL, balance); }, [balance]);
  useEffect(() => { sv(K_SET, settlement); }, [settlement]);

  const tierName = stopLoss ? STOP_LOSS_TO_TIER[stopLoss] : "SL 2%";
  const dd = stopLoss ?? 2;
  // Legacy 1-day rate retained for the (now-dormant) legacy code paths
  // that still reference `premium`/`tenor`/`ppk`. Active form display
  // uses the biweekly per-day rate below.
  const serverRate = regimeInfo?.tiers?.find((t) => t.slPct === dd)?.premiumPer1kUsd;
  const ppk = serverRate ?? SL_RATE[dd as StopLoss] ?? 3;
  const tenor = SL_TENOR[dd as StopLoss] ?? 3;
  const premium = (positionSize / 1000) * ppk;
  void tierName; void premium; void tenor; // marked unused but retained for legacy paths
  // Biweekly per-day display values (PR 5).
  // Daily rate = $/$1k × position notional / 1000. Max projected = daily × 14.
  const biweeklyRatePer1k = BIWEEKLY_RATE_PER_1K_DAY[dd as StopLoss] ?? 2.5;
  const biweeklyDailyRate = (positionSize / 1000) * biweeklyRatePer1k;
  const biweeklyMaxCharge = biweeklyDailyRate * BIWEEKLY_MAX_TENOR_DAYS;
  const payout = positionSize * (dd / 100);
  const floor = livePrice && stopLoss ? (positionType === "short" ? livePrice * (1 + dd / 100) : livePrice * (1 - dd / 100)) : null;
  const ready = positionType !== null && stopLoss !== null;
  const actives = positions.filter(p => p.status === "active");
  const closed = positions.filter(p => p.status === "closed" || p.status === "triggered");
  const uPnl = actives.reduce((s, p) => { if (!livePrice || !p.entryPrice || p.entryPrice <= 0) return s; return s + (p.type === "long" ? ((livePrice - p.entryPrice) / p.entryPrice) * p.size : ((p.entryPrice - livePrice) / p.entryPrice) * p.size); }, 0);
  const fresh = Date.now() - priceTs < 1500;

  useEffect(() => { let on = true; const poll = async () => { try { const d = await fetchRef(); if (on && d.status === "ok") { setLivePrice(Number(d.reference.price)); setPriceTs(Date.now()); setPriceError(null); } } catch (e: any) { if (on) setPriceError(e.message); } }; poll(); const id = setInterval(poll, 3000); return () => { on = false; clearInterval(id); }; }, []);
  // Design A — poll the pricing regime once at mount and then every 60
  // seconds. The server regime is cached for 5 minutes upstream; this
  // 60s cadence is just to keep the widget label fresh as conditions
  // change. Failures silently fall back to the previous regime info
  // (or to SL_RATE constants if no regime has loaded yet).
  useEffect(() => {
    let on = true;
    const poll = async () => {
      try {
        const r = await fetchRegime();
        if (on && r.status === "ok") setRegimeInfo(r);
      } catch {
        // intentionally silent — regime is best-effort
      }
    };
    poll();
    const id = setInterval(poll, 60_000);
    return () => { on = false; clearInterval(id); };
  }, []);

  useEffect(() => {
    const pa = actives.filter(p => p.protectionId);
    if (!pa.length) return;
    let on = true;
    const poll = async () => {
      for (const pos of pa) {
        if (!on || !pos.protectionId) continue;
        try {
          const d = await fetchMon(pos.protectionId);
          if (!on) return;

          // 2026-04-22: server-side reconciliation. If the protection was
          // archived by admin (test-reset-protections endpoint, manual
          // intervention) the server now returns archivedAt in the monitor
          // payload. Drop the local position entry — without this fix the
          // widget kept showing ghost positions until the operator manually
          // cleared localStorage.
          if (d.protection?.archivedAt) {
            setPositions(prev => prev.filter(p => p.id !== pos.id));
            setMonitors(prev => {
              const next = { ...prev };
              delete next[pos.id];
              return next;
            });
            continue;
          }

          if (d.protection?.renewedTo && (d.protection?.status === "expired_otm" || d.protection?.status === "expired_itm" || d.protection?.status === "cancelled")) {
            const newId = d.protection.renewedTo;
            try {
              const renewed = await fetchMon(newId);
              if (!on) return;
              setPositions(prev => prev.map(p => p.id === pos.id ? { ...p, protectionId: newId } : p));
              setMonitors(prev => ({ ...prev, [pos.id]: renewed }));
              setToast(`Position #${pos.num} — Protection auto-renewed`);
            } catch {}
            continue;
          }

          setMonitors(prev => ({ ...prev, [pos.id]: d }));
          if (d.protection?.status === "triggered") {
            const pay = Number(d.protection.payoutDueAmount || 0);
            setPositions(prev => prev.map(p => p.id === pos.id ? { ...p, status: "triggered" as const, closedPayout: pay } : p));
            setBalance(b => { const nb = b + pay; sv(K_BAL, nb); return nb; });
            setSettlement(s => { const ns = { ...s, totalPayouts: s.totalPayouts + pay }; sv(K_SET, ns); return ns; });
            setToast(`Position #${pos.num} triggered — Payout ${fmt(pay)}`);
          }
        } catch (err: any) {
          // 2026-04-22: same reconciliation when the server returns 404
          // (protection deleted at DB level — rare but possible). Without
          // this branch the widget kept ghost positions for protections
          // that no longer exist server-side.
          const msg = String(err?.message || "");
          if (msg.includes("not_found") || msg.includes("404") || msg.includes("Not Found")) {
            setPositions(prev => prev.filter(p => p.id !== pos.id));
            setMonitors(prev => {
              const next = { ...prev };
              delete next[pos.id];
              return next;
            });
          }
        }
      }
    };
    poll(); const id = setInterval(poll, 5000);
    return () => { on = false; clearInterval(id); };
  }, [actives.map(p => p.id + (p.protectionId || "")).join(",")]);

  const nextNum = () => { posNumRef.current++; sv(K_NUM, posNumRef.current); return posNumRef.current; };

  // PR 5 of biweekly cutover (2026-04-30): doProtect now opens biweekly
  // subscriptions instead of 1-day premium-billed protections. The server
  // dispatches based on product:"biweekly" in the request body — when the
  // PILOT_BIWEEKLY_ENABLED env flag is on, the request goes through the
  // new biweekly handler (PR 3) and creates a 14-day max protection.
  // When the flag is off, the server returns biweekly_disabled and the
  // widget surfaces the error.
  //
  // Returns the new protection ID + the per-day rate + max projected
  // charge so the local Position cache can render the running tally
  // immediately, before the first monitor poll.
  const doProtect = useCallback(async (posSize: number, posType: "long" | "short", sl: number, ep: number) => {
    const q = await fetchBiweeklyQuote({
      protectedNotional: posSize,
      foxifyExposureNotional: posSize,
      entryPrice: ep,
      slPct: sl,
      tierName: STOP_LOSS_TO_TIER[sl as StopLoss] || "SL 2%",
      drawdownFloorPct: sl / 100,
      protectionType: posType
    });
    const r = await activateBiweeklyProt({
      quoteId: q.quoteId,
      protectedNotional: posSize,
      foxifyExposureNotional: posSize,
      entryPrice: ep,
      slPct: sl,
      tierName: STOP_LOSS_TO_TIER[sl as StopLoss] || "SL 2%",
      drawdownFloorPct: sl / 100,
      protectionType: posType
    });
    const pid = r.protection?.id || null;
    const activatedAtMs = r.protection?.createdAt ? new Date(r.protection.createdAt).getTime() : Date.now();
    return {
      pid,
      dailyRateUsd: q.ratePerDayUsd,
      maxProjectedCharge: q.maxProjectedChargeUsd,
      tenorDays: q.maxTenorDays,
      activatedAtMs
    };
  }, []);

  const handleOpenProtected = useCallback(async () => {
    if (!livePrice || !ready || !positionType || !stopLoss) return;
    setActivating(true); setActivateError(null);
    try {
      const ep = livePrice;
      const result = await doProtect(positionSize, positionType, dd, ep);
      if (!result.pid) throw new Error("Protection activation failed — no protection ID returned");
      const num = nextNum();
      // Biweekly: charge starts at $0; accumulates over time. premium=0
      // initially, gets refreshed from monitor poll once accumulated_charge
      // is non-zero on the server.
      setPositions(prev => [...prev, {
        id: `pos_${num}_${Date.now()}`,
        num,
        type: positionType,
        size: positionSize,
        stopLoss: dd,
        entryPrice: ep,
        protectionId: result.pid,
        autoRenew: false, // biweekly doesn't use auto-renew
        premium: 0,
        status: "active",
        closedPnl: null,
        closedPayout: null,
        tenorDays: result.tenorDays,
        dailyRateUsd: result.dailyRateUsd,
        maxProjectedCharge: result.maxProjectedCharge,
        activatedAtMs: result.activatedAtMs
      }]);
      // Settlement total starts at 0 for biweekly (no upfront premium).
      // Accumulated charges feed into settlement at close time.
      setPositionType(null); setStopLoss(null);
      setPosOpen(true);
      setToast(`Position #${num} opened — $${result.dailyRateUsd.toFixed(2)}/day, max $${result.maxProjectedCharge.toFixed(0)} over ${result.tenorDays} days`);
    } catch (e: any) { setActivateError(e.message); } finally { setActivating(false); }
  }, [livePrice, ready, positionSize, dd, positionType, doProtect]);

  // 2026-04-29: handleOpenWithout (and the matching "Open Without" button
  // below) was removed. The button sat side-by-side with "Open + Protect"
  // and was one accidental tap away; it created a localStorage-only
  // position with protectionId=null that never touched the backend, then
  // sat in the Active Positions list looking like a real trade. The
  // pilot's purpose is to test protection, not unprotected positions, so
  // removing the entry path entirely is the right call. Existing local-
  // only rows from before this change continue to render until the user
  // dismisses them with the existing Close button — they're a fixed,
  // shrinking set; no auto-cleanup added so nothing disappears on its
  // own. The "Add Protection" button on local-only rows (handleAddProtection
  // below) is left in place: it's harmless dead UI for new sessions and
  // a useful upgrade path for users with pre-existing local-only rows.

  const handleAddProtection = useCallback(async (posId: string) => {
    const pos = positions.find(p => p.id === posId);
    if (!pos || pos.protectionId || !livePrice) return;
    setProtectingPosId(posId);
    try {
      const result = await doProtect(pos.size, pos.type, pos.stopLoss, pos.entryPrice);
      if (!result.pid) throw new Error("Protection activation failed — no protection ID returned");
      setPositions(prev => prev.map(p => p.id === posId ? {
        ...p,
        protectionId: result.pid,
        premium: 0,
        tenorDays: result.tenorDays,
        dailyRateUsd: result.dailyRateUsd,
        maxProjectedCharge: result.maxProjectedCharge,
        activatedAtMs: result.activatedAtMs
      } : p));
      setToast(`Protection added to Position #${pos.num} — $${result.dailyRateUsd.toFixed(2)}/day, max $${result.maxProjectedCharge.toFixed(0)} over ${result.tenorDays} days`);
    } catch (e: any) { setActivateError(e.message); } finally { setProtectingPosId(null); }
  }, [positions, livePrice, doProtect]);

  // PR 5: handleClose now branches by position type.
  //
  // Biweekly + protected → call server /pilot/protections/:id/close,
  //   server settles accumulated charge, returns final billed amount.
  //   We surface the bill in the toast and update local state with the
  //   server-confirmed numbers.
  //
  // Legacy 1-day or local-only positions → original local-only close
  //   (no server call). Computes synthetic P&L from entry vs current.
  const [closingPosId, setClosingPosId] = useState<string | null>(null);
  const [closeConfirmPosId, setCloseConfirmPosId] = useState<string | null>(null);

  const handleClose = useCallback(async (posId: string) => {
    const pos = positions.find(p => p.id === posId);
    if (!pos) return;
    // Local-only or legacy 1-day → original behavior
    if (!pos.protectionId || !isBiweeklyPosition(pos)) {
      setPositions(prev => prev.map(p => {
        if (p.id !== posId || p.status !== "active") return p;
        const price = livePrice || p.entryPrice;
        const pnl = p.type === "long" ? ((price - p.entryPrice) / p.entryPrice) * p.size : ((p.entryPrice - price) / p.entryPrice) * p.size;
        return { ...p, status: "closed" as const, closedPnl: pnl };
      }));
      setToast(`Position #${pos.num} closed`);
      return;
    }
    // Biweekly: call server close endpoint
    setClosingPosId(posId);
    try {
      const res = await closeBiweeklyProt(pos.protectionId);
      // Server returns the authoritative bill. Update local state and
      // mirror in settlement totals so the trader sees the final charge.
      const billed = res.accumulatedChargeUsd;
      const days = res.daysBilled;
      const wasNewClose = res.newlyClosed;
      setPositions(prev => prev.map(p => p.id === posId ? {
        ...p,
        status: "closed" as const,
        premium: billed,
        closedPnl: -billed
      } : p));
      setBalance(b => {
        // Settle the bill against balance only on a newly-closed call
        // to avoid double-charging if the trader retries.
        if (!wasNewClose) return b;
        const nb = Math.max(0, b - billed);
        sv(K_BAL, nb);
        return nb;
      });
      setSettlement(s => {
        if (!wasNewClose) return s;
        const ns = { ...s, totalPremiums: s.totalPremiums + billed };
        sv(K_SET, ns);
        return ns;
      });
      setToast(
        wasNewClose
          ? `Position #${pos.num} closed — billed $${billed.toFixed(2)} for ${days} day${days === 1 ? "" : "s"}`
          : `Position #${pos.num} was already closed (billed $${billed.toFixed(2)})`
      );
    } catch (e: any) {
      const msg = String(e?.message || "close_failed");
      setActivateError(
        msg.includes("not_biweekly")
          ? "This protection is on the legacy 1-day plan; no end-protection action available."
          : msg.includes("not_found")
            ? "Protection no longer exists. Refresh."
            : `Could not close protection: ${msg}`
      );
    } finally {
      setClosingPosId(null);
      setCloseConfirmPosId(null);
    }
  }, [positions, livePrice]);

  // Handler for the inline "Close" button on legacy/unprotected rows.
  // Wraps handleClose for the local-only path (no confirmation needed —
  // local-only close is risk-free and can be undone via undo not needed).
  const handleCloseLocal = (posId: string) => {
    void handleClose(posId);
  };

  // Toggle auto-renew on an open protection (Pilot Agreement §3.3 — at Client's discretion).
  // The current cycle still runs to natural expiry; this only affects whether a NEW protection
  // is created at expiry. Optimistic UI flip + server confirm + fresh monitor refetch.
  const handleToggleAutoRenew = useCallback(async (posId: string) => {
    const pos = positions.find(p => p.id === posId);
    if (!pos || !pos.protectionId) return;
    const next = !pos.autoRenew;
    const prev = pos.autoRenew;
    setAutoRenewToggling(posId);
    setPositions(p => p.map(x => x.id === posId ? { ...x, autoRenew: next } : x));
    try {
      const res = await toggleAutoRenew(pos.protectionId, next);
      // Refetch monitor so the cached row reflects server truth (and the server's
      // metadata.autoRenewToggles audit field is visible if anyone inspects it).
      try {
        const fresh = await fetchMon(pos.protectionId);
        setMonitors(prevMon => ({ ...prevMon, [posId]: fresh }));
      } catch { /* monitor refresh is best-effort */ }
      if (res.idempotentReplay) {
        setToast(`Position #${pos.num} — auto-renew already ${next ? "on" : "off"}`);
      } else if (next) {
        setToast(`Position #${pos.num} — auto-renew ON. Will renew at expiry.`);
      } else {
        setToast(`Position #${pos.num} — auto-renew OFF. Current cycle runs to expiry; no new cycle.`);
      }
    } catch (e: any) {
      // Roll back optimistic update on failure.
      setPositions(p => p.map(x => x.id === posId ? { ...x, autoRenew: prev } : x));
      const msg = String(e?.message || "auto_renew_toggle_failed");
      // 409 protection_not_active surfaces as a friendly explanation.
      const friendly =
        msg.includes("protection_not_active")
          ? "Auto-renew can only be changed on an active protection."
          : msg.includes("not_found")
            ? "Protection no longer exists. Refresh to see latest state."
            : msg.includes("status_changed")
              ? "Protection status changed mid-toggle (likely just triggered or expired). Refresh and try again."
              : `Could not toggle auto-renew: ${msg}`;
      setActivateError(friendly);
    } finally {
      setAutoRenewToggling(null);
    }
  }, [positions]);

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 500 }}>
        <div className="title">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <img src={LOGO} alt="" style={{ width: 24, height: 24, borderRadius: 6 }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
            <span style={{ fontSize: 16, fontWeight: 700, letterSpacing: 0.2 }}>Foxify Perp Protect</span>
          </div>
          {livePrice && (
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 11, color: "var(--muted)" }}>BTC</span>
              <span style={{ fontSize: 14, fontWeight: 600, fontVariantNumeric: "tabular-nums", transition: "color 0.3s", color: fresh ? "var(--text)" : "var(--muted)" }}>{fmt(livePrice)}</span>
              {!priceError && <span style={{ width: 6, height: 6, borderRadius: "50%", display: "inline-block", background: fresh ? "var(--success)" : "var(--muted)", transition: "background 0.3s" }} />}
            </div>
          )}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", marginBottom: 14, borderRadius: 8, background: "var(--card-2)", border: "1px solid var(--border)" }}>
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Account Balance</span>
          <span style={{ fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", color: (balance + uPnl) >= INIT_BAL ? "var(--success)" : "var(--text)" }}>{fmtWhole(Math.round(balance + uPnl))}</span>
        </div>

        {toast && <Toast message={toast} onDone={() => setToast(null)} />}

        {/* ── FORM ── */}
        <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
          {(["long", "short"] as const).map(s => (
            <button key={s} onClick={() => setPositionType(s)} style={{ flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer", fontSize: 13, fontWeight: 600, textTransform: "capitalize", border: positionType === s ? s === "long" ? "1.5px solid var(--success)" : "1.5px solid var(--danger)" : "1px solid var(--border)", background: positionType === s ? s === "long" ? "rgba(54,211,141,0.15)" : "rgba(255,107,107,0.15)" : "var(--card-2)", color: positionType === s ? s === "long" ? "var(--success)" : "var(--danger)" : "var(--muted)", transition: "all 0.15s ease" }}>{s}</button>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Position Size</span>
          <div style={{ display: "flex", alignItems: "center", borderRadius: 8, overflow: "hidden", border: "1px solid var(--border)" }}>
            <button onClick={() => setPositionSize(s => Math.max(POS_MIN, s - POS_STEP))} disabled={positionSize <= POS_MIN} style={{ width: 36, height: 36, border: "none", cursor: "pointer", background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", opacity: positionSize <= POS_MIN ? 0.3 : 1 }}>−</button>
            <div style={{ minWidth: 110, height: 36, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, fontWeight: 700, fontVariantNumeric: "tabular-nums", background: "var(--bg)", borderLeft: "1px solid var(--border)", borderRight: "1px solid var(--border)", userSelect: "none" }}>{fmtWhole(positionSize)}</div>
            <button onClick={() => setPositionSize(s => Math.min(POS_MAX, s + POS_STEP))} disabled={positionSize >= POS_MAX} style={{ width: 36, height: 36, border: "none", cursor: "pointer", background: "var(--card-2)", color: "var(--text)", fontSize: 18, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "center", opacity: positionSize >= POS_MAX ? 0.3 : 1 }}>+</button>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <span style={{ fontSize: 13, color: "var(--muted)", fontWeight: 500 }}>Stop Loss</span>
          <div style={{ display: "flex", gap: 6 }}>
            {STOP_LOSS_OPTIONS.map(sl => (
              <button key={sl} onClick={() => setStopLoss(sl)} style={{ padding: "7px 16px", border: "1px solid var(--border)", borderRadius: 8, cursor: "pointer", fontSize: 13, fontWeight: 600, background: stopLoss === sl ? "rgba(184,90,28,0.18)" : "var(--card-2)", color: stopLoss === sl ? "var(--accent)" : "var(--text)", borderColor: stopLoss === sl ? "var(--accent-2)" : "var(--border)", transition: "all 0.15s ease" }}>{sl}%</button>
            ))}
          </div>
        </div>

        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12, marginTop: 4 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 10 }}>Protect Your Position</div>
          {activateError && <div style={{ color: "var(--danger)", fontSize: 12, marginBottom: 10, padding: "8px 10px", background: "rgba(255,107,107,0.08)", borderRadius: 8, border: "1px solid rgba(255,107,107,0.2)", wordBreak: "break-word" }}>{activateError}</div>}
          {/* PR 5 of biweekly cutover: per-day subscription pricing display.
              Replaces the old "Premium $X for 1 day" with daily rate +
              max-projected-charge framing. The trader sees what they pay
              per day and the worst case if they hold the full 14 days. */}
          <div style={{ background: "rgba(54,211,141,0.06)", border: "1px solid rgba(54,211,141,0.18)", borderRadius: 12, padding: 14, marginBottom: 12, opacity: ready ? 1 : 0.5 }}>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
              {ready ? <>If your position hits <strong style={{ color: "var(--danger)" }}>{dd}%</strong> stop loss, you receive <strong style={{ color: "var(--success)" }}>{fmt(payout)}</strong> instantly.</> : <span style={{ color: "var(--muted)" }}>Select position type and stop loss to see protection details.</span>}
            </div>
            {ready && <>
              {/* Per-day rate is the headline number; max-projected is the
                  worst-case ceiling if held for the full 14-day max tenor.
                  Trader can close anytime and only pays for days actually held. */}
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}>
                <span>Daily rate</span>
                <span style={{ fontWeight: 600, color: "var(--text)" }}>{fmt(biweeklyDailyRate)}/day</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                <span>Max if held to {BIWEEKLY_MAX_TENOR_DAYS} days</span>
                <span style={{ fontWeight: 500 }}>{fmt(biweeklyMaxCharge)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
                <span>Close anytime</span>
                <span style={{ fontWeight: 500, fontStyle: "italic" }}>only pay for days held</span>
              </div>
              {floor && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 6 }}><span>{positionType === "long" ? "Floor Price" : "Ceiling Price"}</span><span style={{ fontWeight: 500 }}>{fmt(floor)}</span></div>}
              {regimeInfo?.pricingRegimeLabel && (
                <div
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 6, opacity: 0.8 }}
                  title="Volatility regime is informational; biweekly daily rate is currently flat across regimes."
                >
                  <span>Volatility</span>
                  <span style={{ fontWeight: 500 }}>{regimeInfo.pricingRegimeLabel}</span>
                </div>
              )}
            </>}
          </div>
          <button onClick={handleOpenProtected} disabled={!ready || activating || !livePrice} style={{ width: "100%", padding: "12px 0", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", opacity: (!ready || activating || !livePrice) ? 0.5 : 1 }}>{activating ? "Opening..." : `Open + Protect (${fmt(biweeklyDailyRate)}/day)`}</button>
        </div>

        {/* ── ACTIVE POSITIONS ── */}
        {actives.length > 0 && (
          <Section title="Active Positions" badge={`${actives.length}`} open={posOpen} onToggle={() => setPosOpen(o => !o)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {actives.map(pos => {
                const mon = monitors[pos.id];
                const canCalcPnl = livePrice && pos.entryPrice > 0;
                const pnl = canCalcPnl ? (pos.type === "long" ? ((livePrice - pos.entryPrice) / pos.entryPrice) * pos.size : ((pos.entryPrice - livePrice) / pos.entryPrice) * pos.size) : null;
                const pnlPct = canCalcPnl ? (pos.type === "long" ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100) : null;
                const fl = pos.type === "long" ? pos.entryPrice * (1 - pos.stopLoss / 100) : pos.entryPrice * (1 + pos.stopLoss / 100);
                const isProtecting = protectingPosId === pos.id;
                const isClosing = closingPosId === pos.id;
                const protectionExpired = pos.protectionId && mon?.timeRemaining && mon.timeRemaining.ms <= 0 && !mon.protection?.renewedTo;

                // PR 5: biweekly subscription branch.
                // Compute display values for biweekly rows. The server's
                // accumulated_charge_usd (read from monitor poll if present)
                // is authoritative; client-side fallback is rate × ceil(daysHeld).
                const isBiweekly = isBiweeklyPosition(pos);
                const dailyRate = pos.dailyRateUsd ?? 0;
                const maxCharge = pos.maxProjectedCharge ?? 0;
                const activatedAtMs = pos.activatedAtMs ?? Date.now();
                const daysHeld = isBiweekly ? biweeklyDaysHeldDisplay(activatedAtMs) : 0;
                // Prefer server-confirmed accumulated charge if available;
                // otherwise compute client-side estimate (rate × daysHeld).
                const serverAccCharge = mon?.protection?.accumulatedChargeUsd
                  ? Number(mon.protection.accumulatedChargeUsd)
                  : null;
                const accCharge =
                  isBiweekly
                    ? (serverAccCharge && serverAccCharge > 0 ? serverAccCharge : dailyRate * daysHeld)
                    : 0;

                return (
                  <div key={pos.id} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-2)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "monospace" }}>#{pos.num}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: pos.type === "long" ? "var(--success)" : "var(--danger)" }}>{pos.type}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtWhole(pos.size)}</span>
                        <span style={{ fontSize: 10, color: "var(--muted)" }}>{pos.stopLoss}% SL</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                        {protectionExpired
                          ? <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(240,185,11,0.12)", color: "#f0b90b" }}>Protection Expired</span>
                          : pos.protectionId
                            ? <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Protected</span>
                            : <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(255,107,107,0.12)", color: "var(--danger)" }}>Unprotected</span>}
                        {/* Auto-renew toggle ONLY shown for legacy 1-day protections.
                            Biweekly subscriptions don't have auto-renew — at
                            close the trader explicitly opens a new one. */}
                        {pos.protectionId && !protectionExpired && !isBiweekly && (
                          <button
                            type="button"
                            onClick={() => handleToggleAutoRenew(pos.id)}
                            disabled={autoRenewToggling === pos.id}
                            title={
                              autoRenewToggling === pos.id
                                ? "Saving…"
                                : pos.autoRenew
                                  ? "Auto-renew is ON. Click to turn OFF — current cycle runs to expiry; no new cycle."
                                  : "Auto-renew is OFF. Click to turn ON — a new protection will be created at expiry."
                            }
                            style={{
                              fontSize: 9,
                              fontWeight: 600,
                              padding: "2px 5px",
                              borderRadius: 999,
                              border: pos.autoRenew ? "1px solid rgba(96,165,250,0.35)" : "1px solid var(--border)",
                              background: pos.autoRenew ? "rgba(96,165,250,0.12)" : "var(--card)",
                              color: pos.autoRenew ? "#60a5fa" : "var(--muted)",
                              cursor: autoRenewToggling === pos.id ? "wait" : "pointer",
                              opacity: autoRenewToggling === pos.id ? 0.6 : 1,
                              transition: "all 0.15s ease"
                            }}
                          >
                            {autoRenewToggling === pos.id ? "↻ …" : pos.autoRenew ? "↻ Auto" : "↻ Off"}
                          </button>
                        )}
                      </div>
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      <span>Entry {fmt(pos.entryPrice)}</span>
                      {pnl !== null && <span style={{ fontWeight: 600, color: pnl >= 0 ? "var(--success)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>{fmt(pnl)} ({fPct(pnlPct!)})</span>}
                    </div>
                    {/* Floor/ceiling + tenor row */}
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginBottom: isBiweekly ? 4 : 6 }}>
                      <span>{pos.type === "long" ? "Floor" : "Ceiling"}: {fmt(fl)}</span>
                      {!isBiweekly && pos.protectionId && mon?.timeRemaining && <span>{mon.timeRemaining.ms > 0 ? `${fTime(mon.timeRemaining.ms)} left` : "Expired"}</span>}
                      {!isBiweekly && pos.premium > 0 && <span>Premium: {fmt(pos.premium)}</span>}
                    </div>
                    {/* Biweekly subscription row: day N of 14 + accumulated charge + max */}
                    {isBiweekly && pos.protectionId && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                        <span title="Days held so far. Closes automatically at the 14-day max.">
                          Day {daysHeld} of {pos.tenorDays ?? BIWEEKLY_MAX_TENOR_DAYS}
                        </span>
                        <span title={`Daily rate: ${fmt(dailyRate)}/day. Max if held to expiry: ${fmt(maxCharge)}.`}>
                          Charged so far: <strong style={{ color: "var(--text)" }}>{fmt(accCharge)}</strong>
                          <span style={{ opacity: 0.6 }}> / max {fmt(maxCharge)}</span>
                        </span>
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 6 }}>
                      {!pos.protectionId && (
                        <button onClick={() => handleAddProtection(pos.id)} disabled={isProtecting} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", fontSize: 11, fontWeight: 600, color: "#fff", cursor: "pointer", opacity: isProtecting ? 0.5 : 1 }}>
                          {isProtecting ? "Adding..." : `Add Protection (${fmt((pos.size / 1000) * BIWEEKLY_RATE_PER_1K_DAY[pos.stopLoss as StopLoss] || 0)}/day)`}
                        </button>
                      )}
                      {/* End Protection button — biweekly subscriptions need
                          confirmation since they call the server and settle
                          accumulated charges. Legacy/local-only positions use
                          the inline Close (no confirmation). */}
                      {isBiweekly && pos.protectionId ? (
                        <button
                          onClick={() => setCloseConfirmPosId(pos.id)}
                          disabled={isClosing}
                          style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", fontSize: 11, color: isClosing ? "var(--muted)" : "var(--text)", cursor: isClosing ? "wait" : "pointer", opacity: isClosing ? 0.6 : 1 }}
                        >
                          {isClosing ? "Closing…" : "End Protection"}
                        </button>
                      ) : (
                        <button onClick={() => handleCloseLocal(pos.id)} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", fontSize: 11, color: "var(--muted)", cursor: "pointer" }}>Close</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </Section>
        )}

        {/* ── CLOSED ── */}
        {closed.length > 0 && (
          <Section title="Recently Closed" badge={`${closed.length}`} open={closedOpen} onToggle={() => setClosedOpen(o => !o)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {closed.slice(-5).map(pos => (
                <div key={pos.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px", borderRadius: 8, background: "var(--card-2)", border: "1px solid var(--border)" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "monospace" }}>#{pos.num}</span>
                    <span style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", color: pos.type === "long" ? "var(--success)" : "var(--danger)" }}>{pos.type}</span>
                    <span style={{ fontSize: 12 }}>{fmtWhole(pos.size)}</span>
                    {pos.status === "triggered" && <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 5px", borderRadius: 999, background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Payout: {fmt(pos.closedPayout || 0)}</span>}
                    {pos.status === "closed" && pos.closedPnl !== null && <span style={{ fontSize: 11, fontWeight: 600, color: pos.closedPnl >= 0 ? "var(--success)" : "var(--danger)" }}>P&L: {fmt(pos.closedPnl)}</span>}
                  </div>
                  <button onClick={() => setPositions(prev => prev.filter(p => p.id !== pos.id))} style={{ border: "none", background: "none", color: "var(--muted)", fontSize: 14, cursor: "pointer", padding: "0 4px" }}>×</button>
                </div>
              ))}
            </div>
          </Section>
        )}

        {/* ── SETTLEMENT ── */}
        {(settlement.totalPremiums > 0 || settlement.totalPayouts > 0) && (
          <Section title="Pilot Settlement" open={settlOpen} onToggle={() => setSettlOpen(o => !o)}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--muted)" }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Premiums owed</span><span style={{ fontWeight: 500, color: "var(--text)" }}>{fmt(settlement.totalPremiums)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between" }}><span>Payouts earned</span><span style={{ fontWeight: 500, color: settlement.totalPayouts > 0 ? "var(--success)" : "var(--text)" }}>{fmt(settlement.totalPayouts)}</span></div>
              <div style={{ display: "flex", justifyContent: "space-between", borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 2 }}><span style={{ fontWeight: 600 }}>Net</span><span style={{ fontWeight: 700, color: settlement.totalPayouts - settlement.totalPremiums >= 0 ? "var(--success)" : "var(--danger)" }}>{fmt(settlement.totalPayouts - settlement.totalPremiums)}</span></div>
            </div>
          </Section>
        )}

        <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "var(--muted)", opacity: 0.5 }}>Protection provided by Atticus Strategy, Ltd. &copy; 2026</div>
      </div>

      {/* PR 5: End-protection confirmation modal for biweekly subscriptions.
          Shows the current accumulated bill so the trader knows exactly what
          they're being charged before they confirm. Cancel is the default
          (highlighted button), End Protection is the destructive secondary. */}
      {closeConfirmPosId && (() => {
        const pos = positions.find(p => p.id === closeConfirmPosId);
        if (!pos) return null;
        const dailyRate = pos.dailyRateUsd ?? 0;
        const activatedAtMs = pos.activatedAtMs ?? Date.now();
        const daysHeld = biweeklyDaysHeldDisplay(activatedAtMs);
        const estCharge = dailyRate * daysHeld;
        const isClosing = closingPosId === closeConfirmPosId;
        return (
          <div
            onClick={() => !isClosing && setCloseConfirmPosId(null)}
            style={{
              position: "fixed",
              top: 0, left: 0, right: 0, bottom: 0,
              background: "rgba(0,0,0,0.55)",
              display: "flex", alignItems: "center", justifyContent: "center",
              zIndex: 2000,
              padding: 16
            }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                borderRadius: 12,
                padding: 20,
                maxWidth: 380,
                width: "100%"
              }}
            >
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 8 }}>
                End Protection #{pos.num}?
              </div>
              <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14, lineHeight: 1.5 }}>
                You'll be charged <strong style={{ color: "var(--text)" }}>{fmt(estCharge)}</strong> for {daysHeld} day{daysHeld === 1 ? "" : "s"} held. No future charges.
                <br />
                <span style={{ opacity: 0.7, fontSize: 11 }}>
                  Final amount confirmed by server. Once ended, the protection cannot be reopened — open a new one if you need protection again.
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={() => !isClosing && setCloseConfirmPosId(null)}
                  disabled={isClosing}
                  style={{
                    flex: 1, padding: "10px 0", borderRadius: 8,
                    border: "none",
                    background: "linear-gradient(135deg, var(--accent), var(--accent-2))",
                    color: "#fff", fontSize: 13, fontWeight: 600,
                    cursor: isClosing ? "wait" : "pointer",
                    opacity: isClosing ? 0.5 : 1
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleClose(pos.id)}
                  disabled={isClosing}
                  style={{
                    flex: 1, padding: "10px 0", borderRadius: 8,
                    border: "1px solid var(--danger)",
                    background: "transparent",
                    color: "var(--danger)", fontSize: 13, fontWeight: 600,
                    cursor: isClosing ? "wait" : "pointer",
                    opacity: isClosing ? 0.5 : 1
                  }}
                >
                  {isClosing ? "Ending…" : "End Protection"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <a
        href="https://t.me/willialso"
        target="_blank"
        rel="noopener noreferrer"
        style={{
          position: "fixed", bottom: 20, right: 20,
          display: "flex", alignItems: "center", gap: 6,
          padding: "8px 14px", borderRadius: 999,
          background: "linear-gradient(135deg, #229ED9, #1DA1F2)",
          color: "#fff", fontSize: 12, fontWeight: 600,
          textDecoration: "none", boxShadow: "0 2px 12px rgba(0,0,0,0.3)",
          zIndex: 1000, transition: "transform 0.15s, box-shadow 0.15s"
        }}
        onMouseEnter={e => { (e.target as HTMLElement).style.transform = "scale(1.05)"; }}
        onMouseLeave={e => { (e.target as HTMLElement).style.transform = "scale(1)"; }}
      >
        💬 Help
      </a>
    </div>
  );
}
