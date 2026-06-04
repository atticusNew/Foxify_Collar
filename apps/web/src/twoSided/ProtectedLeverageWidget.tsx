/**
 * Protected Leverage — read-only floor widget (Phase 1, Sai exchange sales artifact / sandbox).
 *
 * Story (the integrated product): trade leveraged, but with a hard floor that REPLACES your
 * liquidation line with a known worst case — you can't be wiped out, and you keep your upside.
 * Pricing is real (cheapest long PUT across Bullish/Deribit/OKX, at the actual listed strike).
 *
 * Honesty footnote: true no-liquidation needs the exchange margin integration (Phase 2). The
 * standalone version caps NET loss at the same number. The worst-case $ is real either way.
 *
 * READ-ONLY. Calls GET /admin/foxify/v2/floor-quote/tiers. Admin-token gated for now.
 */

import { useEffect, useState, useCallback } from "react";
import { adminGet, getToken, clearToken, UnauthorizedError } from "./api";
import { TokenGate, Shell, COLORS as C } from "./widgets";

type FloorTier = {
  margin_fraction: number;
  floor_pct: number;
  floor_strike: number;
  adds_value: boolean;
  available: boolean;
  unavailable_reason: string | null;
  venue: string | null;
  instrument: string | null;
  put_cost_usdc: number | null;
  cost_per_day_usdc: number | null;
  max_loss_usdc: number | null;
  recommended: boolean;
};

type PositionCard = {
  spot: number;
  size_btc: number;
  leverage: number;
  notional_usdc: number;
  margin_usdc: number;
  liquidation_price: number;
  liq_drop_pct: number;
};

type Bundle = {
  as_of: string;
  position: PositionCard;
  tenor_days: number;
  tiers: FloorTier[];
  note: string;
};

const usd = (x: number | null | undefined) => (x == null ? "—" : `$${Math.round(x).toLocaleString()}`);
const usd2 = (x: number | null | undefined) =>
  x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

const LEV_PRESETS = [2, 5, 10, 20, 40];
const MAX_LEV = 40;

/** Plain-language tier name: tighter floor (smaller fraction risked) = safer. */
const tierName = (fraction: number) => (fraction <= 0.33 ? "Safer" : fraction <= 0.6 ? "Balanced" : "Cheapest");

export function ProtectedLeverageWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("admin"));
  const [collateral, setCollateral] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [tenorDays] = useState(3);
  const [selected, setSelected] = useState<number | null>(null);
  const [activated, setActivated] = useState(false);
  const [simDropPct, setSimDropPct] = useState(0);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getToken("admin")) { setAuthed(false); return; }
    setLoading(true);
    setErr(null);
    try {
      const data = await adminGet<Bundle>(`/admin/foxify/v2/floor-quote/tiers?collateral=${collateral}&leverage=${leverage}&tenor_days=${tenorDays}`);
      setBundle(data);
      const rec = data.tiers.findIndex((t) => t.recommended);
      const firstAvail = data.tiers.findIndex((t) => t.available);
      setSelected((prev) => (prev != null && data.tiers[prev]?.available ? prev : rec >= 0 ? rec : firstAvail));
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message);
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }, [collateral, leverage, tenorDays]);

  useEffect(() => {
    if (!authed) return;
    setActivated(false);
    const id = setTimeout(load, 350);
    return () => clearTimeout(id);
  }, [authed, load]);

  if (!authed) {
    return <TokenGate role="admin" title="Protected Leverage — demo access" onSubmit={() => setAuthed(true)} />;
  }

  const pos = bundle?.position;
  const tiers = bundle?.tiers ?? [];
  const sel = selected != null ? tiers[selected] : null;
  const anyAvail = tiers.some((t) => t.available);

  return (
    <Shell
      title="Protected Leverage"
      subtitle="Trade leveraged — without the wipe-out. Read-only demo."
      updatedIso={bundle?.as_of}
      onSignOut={() => { clearToken("admin"); setAuthed(false); }}
    >
      <div style={{ maxWidth: 540, margin: "0 auto" }}>
        {/* Live spot header */}
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 14, padding: "0 2px" }}>
          <div style={{ fontSize: 12, color: C.muted, letterSpacing: 0.5 }}>BTC / USD{loading && " · …"}</div>
          <div style={{ fontSize: 26, fontWeight: 800, color: C.text, fontVariantNumeric: "tabular-nums" }}>{pos ? usd(pos.spot) : "—"}</div>
        </div>

        {/* 1 · Position */}
        <Card>
          <Row>
            <label style={lbl}>Collateral</label>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, fontSize: 14 }}>$</span>
              <input type="number" min={10} step={50} value={collateral}
                onChange={(e) => setCollateral(Math.max(10, Number(e.target.value) || 10))}
                style={{ ...input, paddingLeft: 22 }} />
            </div>
            <span style={{ color: C.muted, fontSize: 11 }}>USDC</span>
          </Row>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
            <label style={lbl}>Leverage</label>
            <div style={{ display: "flex", gap: 6, flex: 1, flexWrap: "wrap" }}>
              {LEV_PRESETS.map((l) => (
                <Chip key={l} active={leverage === l} label={`${l}×`} onClick={() => setLeverage(l)} />
              ))}
              <input type="number" min={1} max={MAX_LEV} value={leverage}
                onChange={(e) => setLeverage(Math.min(MAX_LEV, Math.max(1, Math.round(Number(e.target.value) || 1))))}
                style={{ ...input, width: 58, flex: "0 0 auto", textAlign: "center", padding: "6px 6px" }} />
            </div>
          </div>
          {pos && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
              You control <b style={{ color: C.text }}>{usd(pos.notional_usdc)}</b> of BTC at {leverage}× on <b style={{ color: C.text }}>{usd(pos.margin_usdc)}</b> margin.
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 12, borderRadius: 6, marginBottom: 14 }}>{err}</div>}

        {/* 2 · The transformation (price ladder) */}
        {pos && sel?.available && (
          <Card>
            <div style={{ fontSize: 20, fontWeight: 800, color: C.green, marginBottom: 4 }}>Can&apos;t be wiped out</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, lineHeight: 1.5 }}>
              Your floor catches you <b style={{ color: C.text }}>before</b> liquidation. Worst case <b style={{ color: C.green }}>{usd(sel.max_loss_usdc)}</b> — your upside stays yours.
            </div>
            <PriceLadder spot={pos.spot} floorStrike={sel.floor_strike} liqPrice={pos.liquidation_price} worstCase={sel.max_loss_usdc} margin={pos.margin_usdc} />
          </Card>
        )}

        {/* 3 · Choose floor */}
        {pos && (
          <Card>
            <SectionLabel>Choose your protection {loading && <span style={{ color: C.muted, fontWeight: 400 }}>· pricing…</span>}</SectionLabel>
            {anyAvail ? (
              <div style={{ display: "grid", gap: 8 }}>
                {tiers.filter((t) => t.available).map((t) => {
                  const idx = tiers.indexOf(t);
                  return <TierRow key={t.floor_strike} tier={t} selected={selected === idx} onClick={() => { setSelected(idx); setActivated(false); }} />;
                })}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: C.amber, lineHeight: 1.5 }}>
                No tradable floor sits inside your liquidation distance at {leverage}×. Lower your leverage to unlock protection.
              </div>
            )}
          </Card>
        )}

        {/* 4 · Confirm + simulate */}
        {pos && sel?.available && (
          <Card highlight>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
                Floor your worst case at <b style={{ color: C.green }}>{usd(sel.max_loss_usdc)}</b> for{" "}
                <b>{usd2(sel.put_cost_usdc)}</b> <span style={{ color: C.muted }}>({usd2(sel.cost_per_day_usdc)}/day · {bundle?.tenor_days}d)</span>.
              </div>
              {!activated ? (
                <button onClick={() => { setActivated(true); setSimDropPct(0); }}
                  style={{ padding: "10px 18px", background: C.green, color: "#06210a", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" }}>
                  Activate protection
                </button>
              ) : (
                <span style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>✓ Protection active</span>
              )}
            </div>
            {activated && <Simulator pos={pos} tier={sel} dropPct={simDropPct} onDrop={setSimDropPct} />}
          </Card>
        )}

        {/* details */}
        {bundle && <Details bundle={bundle} />}
      </div>
    </Shell>
  );
}

/** Vertical price ladder: spot on top → green floor (loss capped) → red, struck-through liq. */
function PriceLadder({ spot, floorStrike, liqPrice, worstCase, margin }: { spot: number; floorStrike: number; liqPrice: number; worstCase: number | null; margin: number }) {
  const rows = [
    { color: C.text, dot: C.muted, label: "BTC now", price: spot, note: "your entry", strike: false },
    { color: C.green, dot: C.green, label: "Your floor", price: floorStrike, note: `loss capped at ${usd(worstCase)}`, strike: false },
    { color: C.red, dot: C.red, label: "Old liquidation", price: liqPrice, note: `you'd lose your ${usd(margin)} — not anymore`, strike: true }
  ];
  return (
    <div style={{ borderLeft: `2px solid ${C.border}`, marginLeft: 6, paddingLeft: 16 }}>
      {rows.map((r, i) => (
        <div key={i} style={{ position: "relative", paddingBottom: i < rows.length - 1 ? 18 : 0 }}>
          <span style={{ position: "absolute", left: -23, top: 4, width: 10, height: 10, borderRadius: 6, background: r.dot, border: `2px solid ${C.panel}` }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontSize: 12, color: C.muted }}>{r.label}</span>
            <span style={{ fontSize: 16, fontWeight: 700, color: r.color, textDecoration: r.strike ? "line-through" : "none", fontVariantNumeric: "tabular-nums" }}>{usd(r.price)}</span>
          </div>
          <div style={{ fontSize: 11, color: r.color === C.text ? C.muted : r.color, opacity: r.color === C.text ? 1 : 0.85, marginTop: 2 }}>{r.note}</div>
        </div>
      ))}
    </div>
  );
}

/** Interactive "drag a BTC drop and watch the floor hold." Pure client-side math. */
function Simulator({ pos, tier, dropPct, onDrop }: { pos: PositionCard; tier: FloorTier; dropPct: number; onDrop: (v: number) => void }) {
  const price = pos.spot * (1 - dropPct);
  const size = pos.size_btc;
  const perpPnl = (price - pos.spot) * size;
  const liquidated = price <= pos.liquidation_price;
  const unprotectedPnl = liquidated ? -pos.margin_usdc : perpPnl;
  const premium = tier.put_cost_usdc ?? 0;
  const strike = tier.floor_strike;
  const protectedPnl = perpPnl + Math.max(0, strike - price) * size - premium;
  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        Simulate a BTC drop: <b style={{ color: C.text }}>−{pct(dropPct)}</b> → {usd(price)}
      </div>
      <input type="range" min={0} max={0.25} step={0.005} value={dropPct} onChange={(e) => onDrop(Number(e.target.value))} style={{ width: "100%", accentColor: C.red }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
        <SimBox tone="bad" heading="Unprotected" big={liquidated ? "LIQUIDATED" : usd(unprotectedPnl)} sub={liquidated ? `lost your full ${usd(pos.margin_usdc)}` : "P&L"} />
        <SimBox tone="good" heading="Protected" big={usd(protectedPnl)} sub={price <= strike ? "floor holding — capped" : "P&L (floor armed)"} />
      </div>
    </div>
  );
}

function Details({ bundle }: { bundle: Bundle }) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginTop: 8, textAlign: "center" }}>
      <span onClick={() => setShow((s) => !s)} style={{ color: C.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>
        {show ? "Hide details" : "How it's priced"}
      </span>
      {show && (
        <div style={{ marginTop: 10, fontSize: 11, color: C.muted, background: C.panel, borderRadius: 6, padding: 12, textAlign: "left", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace" }}>
            <thead><tr style={{ textAlign: "left", color: C.muted }}>
              <th style={td}>Tier</th><th style={td}>Floor</th><th style={td}>Strike</th><th style={td}>Venue</th><th style={td}>Premium</th>
            </tr></thead>
            <tbody>
              {bundle.tiers.map((t) => (
                <tr key={t.floor_strike} style={{ borderTop: `1px solid ${C.border}`, color: t.available ? C.text : "#555" }}>
                  <td style={td}>{tierName(t.margin_fraction)}</td>
                  <td style={td}>{pct(t.floor_pct)}</td>
                  <td style={td}>{usd(t.floor_strike)}</td>
                  <td style={td}>{(t.venue ?? "—").toUpperCase()}</td>
                  <td style={td}>{usd2(t.put_cost_usdc)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 10, lineHeight: 1.5 }}>{bundle.note}</div>
        </div>
      )}
    </div>
  );
}

// ── presentational helpers ──
const td: React.CSSProperties = { padding: "5px 8px" };
const lbl: React.CSSProperties = { width: 80, fontSize: 13, color: C.muted };
const input: React.CSSProperties = { width: "100%", padding: "8px 10px", fontSize: 14, background: C.panel2, color: C.text, border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box" };

function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return <div style={{ background: C.panel, borderRadius: 10, padding: 18, marginBottom: 14, border: highlight ? `1px solid ${C.green}55` : `1px solid ${C.border}` }}>{children}</div>;
}
function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 11, fontWeight: 700, color: C.text, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 12 }}>{children}</div>;
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>{children}</div>;
}
function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      padding: "6px 12px", borderRadius: 6, fontSize: 13, cursor: "pointer",
      background: active ? C.blue + "22" : C.panel2, color: active ? C.blue : C.muted,
      border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400
    }}>{label}</div>
  );
}
function SimBox({ tone, heading, big, sub }: { tone: "good" | "bad"; heading: string; big: string; sub: string }) {
  const col = tone === "good" ? C.green : C.red;
  return (
    <div style={{ background: col + "10", border: `1px solid ${col}33`, borderRadius: 8, padding: "12px 14px", textAlign: "center" }}>
      <div style={{ fontSize: 11, color: C.muted }}>{heading}</div>
      <div style={{ fontSize: 20, fontWeight: 800, color: col, margin: "4px 0" }}>{big}</div>
      <div style={{ fontSize: 10, color: C.muted }}>{sub}</div>
    </div>
  );
}
function TierRow({ tier, selected, onClick }: { tier: FloorTier; selected: boolean; onClick: () => void }) {
  return (
    <div onClick={onClick} style={{
      padding: "12px 14px", borderRadius: 8, cursor: "pointer",
      background: selected ? C.green + "12" : C.panel2,
      border: `1px solid ${selected ? C.green + "88" : "#333"}`,
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>
          {tierName(tier.margin_fraction)}
          {tier.recommended && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}
        </div>
        <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>Worst case {usd(tier.max_loss_usdc)}</div>
      </div>
      <div style={{ textAlign: "right" }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{usd2(tier.put_cost_usdc)}</div>
        <div style={{ fontSize: 10, color: C.muted }}>{usd2(tier.cost_per_day_usdc)}/day</div>
      </div>
    </div>
  );
}
