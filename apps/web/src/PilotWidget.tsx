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
type QuoteResponse = { status: string; protectionType: string; tierName: string; slPct: number | null; drawdownFloorPct: string; triggerPrice: string; floorPrice: string; v7: V7Info | null; quote: { quoteId: string; instrumentId: string; premium: number; expiresAt: string; side: string; quantity: number; venue: string; details?: Record<string, unknown> }; entrySnapshot: { price: string; marketId: string; source: string; timestamp: string } };
type ProtectionRecord = { id: string; status: string; tierName: string; protectedNotional: string; entryPrice: string; floorPrice: string; drawdownFloorPct: string; expiryAt: string; premium: string; autoRenew: boolean; payoutDueAmount: string | null; payoutSettledAmount: string | null; venue: string; instrumentId: string; createdAt: string; metadata?: Record<string, unknown> };
type MonitorResponse = { status: string; protection?: ProtectionRecord & { renewedTo?: string | null; archivedAt?: string | null }; currentPrice?: string; distanceToFloor?: { pct: string; usd: string; direction: string }; timeRemaining?: { ms: number; human: string } };
type Position = { id: string; num: number; type: "long" | "short"; size: number; stopLoss: number; entryPrice: number; protectionId: string | null; autoRenew: boolean; premium: number; status: "active" | "closed" | "triggered"; closedPnl: number | null; closedPayout: number | null };

// ─── Config ──────────────────────────────────────────────────────────

const STOP_LOSS_OPTIONS = [2, 3, 5, 10] as const;
type StopLoss = (typeof STOP_LOSS_OPTIONS)[number];
const STOP_LOSS_TO_TIER: Record<StopLoss, string> = { 2: "SL 2%", 3: "SL 3%", 5: "SL 5%", 10: "SL 10%" };
// Client-side preview only (used to render the "Add Protection ($X)" button
// before a quote round-trip). The authoritative premium comes from the API
// response (V7Info.premiumPer1kUsd) once a quote is fetched. Must mirror
// the LOW-regime row of REGIME_SCHEDULES in
// services/api/src/pilot/pricingRegime.ts (low is the cheapest regime —
// using it as the preview floor avoids momentary "premium just went up"
// flicker when the server returns the actual regime-aware quote).
//
// 2026-04-21: 2% raised from \$6 → \$7 in low regime (tier-mix shaping).
// 2026-04-25: 2% lowered from \$7 → \$6.50 in low regime in response to
//   CEO feedback that calm pricing felt thick. Stress regime unchanged.
//   See pricingRegime.ts §2026-04-25 note.
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
const activateProt = (b: Record<string, unknown>) => api<{ status: string; protectionId: string; protection: ProtectionRecord }>("/pilot/protections/activate", { method: "POST", body: JSON.stringify(b) });
const fetchMon = async (id: string): Promise<MonitorResponse> => {
  const raw = await api<{ status: string; monitor?: MonitorResponse } & MonitorResponse>(`/pilot/protections/${id}/monitor`);
  return raw.monitor || raw;
};
const toggleAutoRenew = (id: string, enabled: boolean) =>
  api<{ status: string; autoRenew: boolean; protection?: ProtectionRecord; idempotentReplay?: boolean; message?: string }>(
    `/pilot/protections/${id}/auto-renew`,
    { method: "POST", body: JSON.stringify({ enabled }) }
  );

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
  const [autoRenew, setAutoRenew] = useState(false);
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
  // Prefer the server-provided regime-aware rate over the static SL_RATE
  // table (which is only the first-paint fallback).
  const serverRate = regimeInfo?.tiers?.find((t) => t.slPct === dd)?.premiumPer1kUsd;
  const ppk = serverRate ?? SL_RATE[dd as StopLoss] ?? 3;
  const tenor = SL_TENOR[dd as StopLoss] ?? 3;
  const premium = (positionSize / 1000) * ppk;
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

  const doProtect = useCallback(async (posSize: number, posType: "long" | "short", sl: number, ep: number, shouldAutoRenew: boolean, existingPosId?: string) => {
    const tn = STOP_LOSS_TO_TIER[sl as StopLoss] || "SL 2%";
    const slTenor = SL_TENOR[sl as StopLoss] ?? 3;
    const q = await fetchQuote({ protectedNotional: posSize, foxifyExposureNotional: posSize, entryPrice: ep, slPct: sl, tierName: tn, drawdownFloorPct: sl / 100, protectionType: posType, tenorDays: slTenor });
    const actualPrem = q.v7?.premiumUsd ?? q.quote.premium;
    const r = await activateProt({ quoteId: q.quote.quoteId, protectedNotional: posSize, foxifyExposureNotional: posSize, entryPrice: ep, slPct: sl, tierName: tn, drawdownFloorPct: sl / 100, autoRenew: shouldAutoRenew, protectionType: posType, tenorDays: slTenor });
    const pid = r.protectionId || r.protection?.id || null;
    return { pid, prem: actualPrem };
  }, []);

  const handleOpenProtected = useCallback(async () => {
    if (!livePrice || !ready || !positionType || !stopLoss) return;
    setActivating(true); setActivateError(null);
    try {
      const ep = livePrice;
      const { pid, prem } = await doProtect(positionSize, positionType, dd, ep, autoRenew);
      if (!pid) throw new Error("Protection activation failed — no protection ID returned");
      const num = nextNum();
      setPositions(prev => [...prev, { id: `pos_${num}_${Date.now()}`, num, type: positionType, size: positionSize, stopLoss: dd, entryPrice: ep, protectionId: pid, autoRenew, premium: prem, status: "active", closedPnl: null, closedPayout: null }]);
      setBalance(b => { const nb = Math.max(0, b - prem); sv(K_BAL, nb); return nb; });
      setSettlement(s => { const ns = { ...s, totalPremiums: s.totalPremiums + prem }; sv(K_SET, ns); return ns; });
      setPositionType(null); setStopLoss(null);
      setPosOpen(true);
      setToast(`Position #${num} opened — Protected`);
    } catch (e: any) { setActivateError(e.message); } finally { setActivating(false); }
  }, [livePrice, ready, positionSize, tierName, dd, positionType, autoRenew, doProtect]);

  const handleOpenWithout = () => {
    if (!livePrice || !ready || !positionType || !stopLoss) return;
    const num = nextNum();
    setPositions(prev => [...prev, { id: `pos_${num}_${Date.now()}`, num, type: positionType, size: positionSize, stopLoss: dd, entryPrice: livePrice, protectionId: null, autoRenew: false, premium: 0, status: "active", closedPnl: null, closedPayout: null }]);
    setPositionType(null); setStopLoss(null);
    setPosOpen(true);
    setToast(`Position #${num} opened — Unprotected`);
  };

  const handleAddProtection = useCallback(async (posId: string) => {
    const pos = positions.find(p => p.id === posId);
    if (!pos || pos.protectionId || !livePrice) return;
    setProtectingPosId(posId);
    try {
      const { pid, prem } = await doProtect(pos.size, pos.type, pos.stopLoss, pos.entryPrice, pos.autoRenew);
      if (!pid) throw new Error("Protection activation failed — no protection ID returned");
      setPositions(prev => prev.map(p => p.id === posId ? { ...p, protectionId: pid, premium: prem } : p));
      setBalance(b => { const nb = Math.max(0, b - prem); sv(K_BAL, nb); return nb; });
      setSettlement(s => { const ns = { ...s, totalPremiums: s.totalPremiums + prem }; sv(K_SET, ns); return ns; });
      setToast(`Protection added to Position #${pos.num}`);
    } catch (e: any) { setActivateError(e.message); } finally { setProtectingPosId(null); }
  }, [positions, livePrice, doProtect]);

  const handleClose = (posId: string) => {
    const pos = positions.find(p => p.id === posId);
    setPositions(prev => prev.map(p => {
      if (p.id !== posId || p.status !== "active") return p;
      const price = livePrice || p.entryPrice;
      const pnl = p.type === "long" ? ((price - p.entryPrice) / p.entryPrice) * p.size : ((p.entryPrice - price) / p.entryPrice) * p.size;
      return { ...p, status: "closed" as const, closedPnl: pnl };
    }));
    if (pos) setToast(`Position #${pos.num} closed`);
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
          <div style={{ background: "rgba(54,211,141,0.06)", border: "1px solid rgba(54,211,141,0.18)", borderRadius: 12, padding: 14, marginBottom: 12, opacity: ready ? 1 : 0.5 }}>
            <div style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 8 }}>
              {ready ? <>If your position hits <strong style={{ color: "var(--danger)" }}>{dd}%</strong> stop loss, you receive <strong style={{ color: "var(--success)" }}>{fmt(payout)}</strong> instantly.</> : <span style={{ color: "var(--muted)" }}>Select position type and stop loss to see protection details.</span>}
            </div>
            {ready && <>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}><span>Premium</span><span style={{ fontWeight: 600, color: "var(--text)" }}>{fmt(premium)} for {tenor} {tenor === 1 ? "day" : "days"}</span></div>
              {floor && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 4 }}><span>{positionType === "long" ? "Floor Price" : "Ceiling Price"}</span><span style={{ fontWeight: 500 }}>{fmt(floor)}</span></div>}
              {regimeInfo?.pricingRegimeLabel && (
                <div
                  style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginTop: 6, opacity: 0.8 }}
                  title="Price reflects current Bitcoin market volatility. See documentation for the schedule."
                >
                  <span>Volatility</span>
                  <span style={{ fontWeight: 500 }}>{regimeInfo.pricingRegimeLabel}</span>
                </div>
              )}
            </>}
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--muted)", marginBottom: 14, cursor: "pointer" }}>
            <input type="checkbox" checked={autoRenew} onChange={e => setAutoRenew(e.target.checked)} style={{ accentColor: "var(--accent)" }} /> Auto-renew protection at expiry
          </label>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={handleOpenProtected} disabled={!ready || activating || !livePrice} style={{ flex: 2, padding: "12px 0", borderRadius: 10, border: "none", fontSize: 14, fontWeight: 600, cursor: "pointer", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", opacity: (!ready || activating || !livePrice) ? 0.5 : 1 }}>{activating ? "Opening..." : "Open + Protect"}</button>
            <button onClick={handleOpenWithout} disabled={!ready || !livePrice} style={{ flex: 1, padding: "12px 0", borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-2)", fontSize: 12, color: "var(--muted)", cursor: "pointer", opacity: (!ready || !livePrice) ? 0.5 : 1 }}>Open Without</button>
          </div>
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
                const protectionExpired = pos.protectionId && mon?.timeRemaining && mon.timeRemaining.ms <= 0 && !mon.protection?.renewedTo;
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
                        {pos.protectionId && !protectionExpired && (
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
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                      <span>{pos.type === "long" ? "Floor" : "Ceiling"}: {fmt(fl)}</span>
                      {pos.protectionId && mon?.timeRemaining && <span>{mon.timeRemaining.ms > 0 ? `${fTime(mon.timeRemaining.ms)} left` : "Expired"}</span>}
                      {pos.premium > 0 && <span>Premium: {fmt(pos.premium)}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!pos.protectionId && (
                        <button onClick={() => handleAddProtection(pos.id)} disabled={isProtecting} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", fontSize: 11, fontWeight: 600, color: "#fff", cursor: "pointer", opacity: isProtecting ? 0.5 : 1 }}>
                          {isProtecting ? "Adding..." : `Add Protection (${fmt((pos.size / 1000) * (SL_RATE[pos.stopLoss as StopLoss] ?? 3))})`}
                        </button>
                      )}
                      <button onClick={() => handleClose(pos.id)} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", fontSize: 11, color: "var(--muted)", cursor: "pointer" }}>Close</button>
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
