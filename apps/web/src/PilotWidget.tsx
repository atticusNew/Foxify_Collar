import { useState, useEffect, useCallback, useRef } from "react";
import { API_BASE } from "./config";

// ─── Types ───────────────────────────────────────────────────────────

type ReferencePrice = { price: string; marketId: string; venue: string; source: string; timestamp: string; ageMs: number };
type QuoteResponse = { status: string; protectionType: string; tierName: string; drawdownFloorPct: string; triggerPrice: string; floorPrice: string; quote: { quoteId: string; instrumentId: string; premium: number; expiresAt: string; side: string; quantity: number; venue: string; details?: Record<string, unknown> }; entrySnapshot: { price: string; marketId: string; source: string; timestamp: string } };
type ProtectionRecord = { id: string; status: string; tierName: string; protectedNotional: string; entryPrice: string; floorPrice: string; drawdownFloorPct: string; expiryAt: string; premium: string; autoRenew: boolean; payoutDueAmount: string | null; payoutSettledAmount: string | null; venue: string; instrumentId: string; createdAt: string; metadata?: Record<string, unknown> };
type MonitorResponse = { status: string; protection?: ProtectionRecord; currentPrice?: string; distanceToFloor?: { pct: string; usd: string; direction: string }; timeRemaining?: { ms: number; human: string } };
type Position = { id: string; num: number; type: "long" | "short"; size: number; stopLoss: number; entryPrice: number; protectionId: string | null; autoRenew: boolean; premium: number; status: "active" | "closed" | "triggered"; closedPnl: number | null; closedPayout: number | null };

// ─── Config ──────────────────────────────────────────────────────────

const STOP_LOSS_OPTIONS = [20, 15, 12] as const;
type StopLoss = (typeof STOP_LOSS_OPTIONS)[number];
const STOP_LOSS_TO_TIER: Record<StopLoss, string> = { 20: "Pro (Bronze)", 15: "Pro (Silver)", 12: "Pro (Gold)" };
const POS_MIN = 5000, POS_MAX = 50000, POS_STEP = 5000, PPK = 11, TENOR = 5, INIT_BAL = 1_000_000;
const K_BAL = "foxify_pilot_balance", K_SET = "foxify_pilot_settlement", K_POS = "foxify_pilot_positions", K_NUM = "foxify_pilot_posnum";
const LOGO = "https://i.ibb.co/SDwxMqS8/Foxify-200x200.png";

// ─── Helpers ─────────────────────────────────────────────────────────

const fmt = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtWhole = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const fPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const fTime = (ms: number): string => { if (ms <= 0) return "Expired"; const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000); return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${m}m`; };

// ─── API ─────────────────────────────────────────────────────────────

const api = async <T = unknown>(p: string, o?: RequestInit): Promise<T> => { const r = await fetch(`${API_BASE}${p}`, { ...o, headers: { "Content-Type": "application/json", ...o?.headers } }); const j = await r.json(); if (!r.ok) throw new Error(j?.reason || j?.message || `HTTP ${r.status}`); return j as T; };
const fetchRef = () => api<{ status: string; reference: ReferencePrice }>("/pilot/reference-price");
const fetchQuote = (b: Record<string, unknown>) => api<QuoteResponse>("/pilot/protections/quote", { method: "POST", body: JSON.stringify(b) });
const activateProt = (b: Record<string, unknown>) => api<{ status: string; protectionId: string; protection: ProtectionRecord }>("/pilot/protections/activate", { method: "POST", body: JSON.stringify(b) });
const fetchMon = (id: string) => api<MonitorResponse>(`/pilot/protections/${id}/monitor`);

// ─── Persistence ─────────────────────────────────────────────────────

type Settl = { totalPremiums: number; totalPayouts: number };
const ld = <T,>(k: string, f: T): T => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } };
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
  useEffect(() => { const t = setTimeout(onDone, 3500); return () => clearTimeout(t); }, [onDone]);
  return (
    <div style={{ padding: "10px 14px", marginBottom: 12, borderRadius: 8, background: "rgba(54,211,141,0.12)", border: "1px solid rgba(54,211,141,0.25)", color: "var(--success)", fontSize: 13, fontWeight: 500, animation: "fadeIn 0.2s ease" }}>
      {message}
    </div>
  );
}

// ─── Widget ──────────────────────────────────────────────────────────

export function PilotWidget() {
  const [positionType, setPositionType] = useState<"long" | "short" | null>(null);
  const [positionSize, setPositionSize] = useState(5000);
  const [stopLoss, setStopLoss] = useState<StopLoss | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [priceTs, setPriceTs] = useState(0);
  const [positions, setPositions] = useState<Position[]>(() => ld(K_POS, []));
  const [activating, setActivating] = useState(false);
  const [protectingPosId, setProtectingPosId] = useState<string | null>(null);
  const [activateError, setActivateError] = useState<string | null>(null);
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

  const tierName = stopLoss ? STOP_LOSS_TO_TIER[stopLoss] : "Pro (Bronze)";
  const dd = stopLoss ?? 20;
  const premium = (positionSize / 1000) * PPK;
  const payout = positionSize * (dd / 100);
  const floor = livePrice && stopLoss ? (positionType === "short" ? livePrice * (1 + dd / 100) : livePrice * (1 - dd / 100)) : null;
  const ready = positionType !== null && stopLoss !== null;
  const actives = positions.filter(p => p.status === "active");
  const closed = positions.filter(p => p.status === "closed" || p.status === "triggered");
  const uPnl = actives.reduce((s, p) => { if (!livePrice) return s; return s + (p.type === "long" ? ((livePrice - p.entryPrice) / p.entryPrice) * p.size : ((p.entryPrice - livePrice) / p.entryPrice) * p.size); }, 0);
  const fresh = Date.now() - priceTs < 1500;

  useEffect(() => { let on = true; const poll = async () => { try { const d = await fetchRef(); if (on && d.status === "ok") { setLivePrice(Number(d.reference.price)); setPriceTs(Date.now()); setPriceError(null); } } catch (e: any) { if (on) setPriceError(e.message); } }; poll(); const id = setInterval(poll, 3000); return () => { on = false; clearInterval(id); }; }, []);

  useEffect(() => {
    const pa = actives.filter(p => p.protectionId);
    if (!pa.length) return;
    let on = true;
    const poll = async () => { for (const pos of pa) { if (!on || !pos.protectionId) continue; try { const d = await fetchMon(pos.protectionId); if (!on) return; setMonitors(prev => ({ ...prev, [pos.id]: d })); if (d.protection?.status === "triggered") { const pay = Number(d.protection.payoutDueAmount || 0); setPositions(prev => prev.map(p => p.id === pos.id ? { ...p, status: "triggered" as const, closedPayout: pay } : p)); setBalance(b => { const nb = b + pay; sv(K_BAL, nb); return nb; }); setSettlement(s => { const ns = { ...s, totalPayouts: s.totalPayouts + pay }; sv(K_SET, ns); return ns; }); setToast(`Position #${pos.num} triggered — Payout ${fmt(pay)}`); } } catch {} } };
    poll(); const id = setInterval(poll, 5000);
    return () => { on = false; clearInterval(id); };
  }, [actives.map(p => p.id + (p.protectionId || "")).join(",")]);

  const nextNum = () => { posNumRef.current++; sv(K_NUM, posNumRef.current); return posNumRef.current; };

  const doProtect = useCallback(async (posSize: number, posType: "long" | "short", sl: number, ep: number, existingPosId?: string) => {
    const tn = STOP_LOSS_TO_TIER[sl as StopLoss] || "Pro (Bronze)";
    const prem = (posSize / 1000) * PPK;
    const q = await fetchQuote({ protectedNotional: posSize, foxifyExposureNotional: posSize, entryPrice: ep, tierName: tn, drawdownFloorPct: sl / 100, protectionType: posType });
    const r = await activateProt({ quoteId: q.quote.quoteId, protectedNotional: posSize, foxifyExposureNotional: posSize, entryPrice: ep, tierName: tn, drawdownFloorPct: sl / 100, autoRenew: false, protectionType: posType });
    const pid = r.protectionId || r.protection?.id || null;
    return { pid, prem };
  }, []);

  const handleOpenProtected = useCallback(async () => {
    if (!livePrice || !ready || !positionType || !stopLoss) return;
    setActivating(true); setActivateError(null);
    try {
      const ep = livePrice;
      const { pid, prem } = await doProtect(positionSize, positionType, dd, ep);
      const num = nextNum();
      setPositions(prev => [...prev, { id: `pos_${num}_${Date.now()}`, num, type: positionType, size: positionSize, stopLoss: dd, entryPrice: ep, protectionId: pid, autoRenew, premium: prem, status: "active", closedPnl: null, closedPayout: null }]);
      setBalance(b => { const nb = b - prem; sv(K_BAL, nb); return nb; });
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
      const { pid, prem } = await doProtect(pos.size, pos.type, pos.stopLoss, pos.entryPrice);
      setPositions(prev => prev.map(p => p.id === posId ? { ...p, protectionId: pid, premium: prem } : p));
      setBalance(b => { const nb = b - prem; sv(K_BAL, nb); return nb; });
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
              {ready ? <>If your position hits <strong style={{ color: "var(--danger)" }}>{dd}%</strong> drawdown, you receive <strong style={{ color: "var(--success)" }}>{fmt(payout)}</strong> instantly.</> : <span style={{ color: "var(--muted)" }}>Select position type and stop loss to see protection details.</span>}
            </div>
            {ready && <>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}><span>Premium</span><span style={{ fontWeight: 600, color: "var(--text)" }}>{fmt(premium)} for {TENOR} days</span></div>
              {floor && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginTop: 4 }}><span>{positionType === "long" ? "Floor Price" : "Ceiling Price"}</span><span style={{ fontWeight: 500 }}>{fmt(floor)}</span></div>}
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
                const pnl = livePrice ? (pos.type === "long" ? ((livePrice - pos.entryPrice) / pos.entryPrice) * pos.size : ((pos.entryPrice - livePrice) / pos.entryPrice) * pos.size) : null;
                const pnlPct = livePrice ? (pos.type === "long" ? ((livePrice - pos.entryPrice) / pos.entryPrice) * 100 : ((pos.entryPrice - livePrice) / pos.entryPrice) * 100) : null;
                const fl = pos.type === "long" ? pos.entryPrice * (1 - pos.stopLoss / 100) : pos.entryPrice * (1 + pos.stopLoss / 100);
                const isProtecting = protectingPosId === pos.id;
                return (
                  <div key={pos.id} style={{ padding: 12, borderRadius: 10, border: "1px solid var(--border)", background: "var(--card-2)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 10, color: "var(--muted)", fontFamily: "monospace" }}>#{pos.num}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, textTransform: "uppercase", color: pos.type === "long" ? "var(--success)" : "var(--danger)" }}>{pos.type}</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{fmtWhole(pos.size)}</span>
                        <span style={{ fontSize: 10, color: "var(--muted)" }}>{pos.stopLoss}% SL</span>
                      </div>
                      {pos.protectionId
                        ? <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(54,211,141,0.12)", color: "var(--success)" }}>Protected</span>
                        : <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", borderRadius: 999, background: "rgba(255,107,107,0.12)", color: "var(--danger)" }}>Unprotected</span>}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)", marginBottom: 4 }}>
                      <span>Entry {fmt(pos.entryPrice)}</span>
                      {pnl !== null && <span style={{ fontWeight: 600, color: pnl >= 0 ? "var(--success)" : "var(--danger)", fontVariantNumeric: "tabular-nums" }}>{fmt(pnl)} ({fPct(pnlPct!)})</span>}
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--muted)", marginBottom: 6 }}>
                      <span>{pos.type === "long" ? "Floor" : "Ceiling"}: {fmt(fl)}</span>
                      {pos.protectionId && mon?.timeRemaining && <span>{fTime(mon.timeRemaining.ms)} left</span>}
                      {pos.premium > 0 && <span>Premium: {fmt(pos.premium)}</span>}
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {!pos.protectionId && (
                        <button onClick={() => handleAddProtection(pos.id)} disabled={isProtecting} style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", fontSize: 11, fontWeight: 600, color: "#fff", cursor: "pointer", opacity: isProtecting ? 0.5 : 1 }}>
                          {isProtecting ? "Adding..." : `Add Protection (${fmt((pos.size / 1000) * PPK)})`}
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
    </div>
  );
}
