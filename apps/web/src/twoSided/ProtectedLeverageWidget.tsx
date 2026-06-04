/**
 * Protected Leverage — read-only floor widget (Phase 1, Sai exchange sales artifact / sandbox).
 *
 * Story we tell (the integrated product): trade leveraged, but with a hard floor that means
 * you CAN'T be wiped out — your liquidation line is replaced by a known worst case, and you
 * keep your upside. Pricing underneath is real (cheapest long PUT across Bullish/Deribit/OKX).
 *
 * Honesty footnote: true no-liquidation needs the exchange margin integration (Phase 2). The
 * standalone version caps NET loss at the same number. Either way the worst-case $ is real.
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

const TENORS = [1, 3, 7];
const MAX_LEV = 40;

/** Plain-language tier name: tighter floor (smaller fraction risked) = safer. */
const tierName = (fraction: number) => (fraction <= 0.33 ? "Safer" : fraction <= 0.6 ? "Balanced" : "Cheapest");

export function ProtectedLeverageWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("admin"));
  const [collateral, setCollateral] = useState(500);
  const [leverage, setLeverage] = useState(10);
  const [tenorDays, setTenorDays] = useState(3);
  const [selected, setSelected] = useState<number | null>(null);
  const [activated, setActivated] = useState(false);
  const [simDropPct, setSimDropPct] = useState(0); // 0..0.25 simulated downward move
  const [showDetails, setShowDetails] = useState(false);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getToken("admin")) { setAuthed(false); return; }
    setLoading(true);
    setErr(null);
    try {
      const q = `collateral=${collateral}&leverage=${leverage}&tenor_days=${tenorDays}`;
      const data = await adminGet<Bundle>(`/admin/foxify/v2/floor-quote/tiers?${q}`);
      setBundle(data);
      const rec = data.tiers.findIndex((t) => t.recommended);
      setSelected((prev) => (prev != null && data.tiers[prev]?.available ? prev : rec >= 0 ? rec : null));
    } catch (e) {
      if (e instanceof UnauthorizedError) { setAuthed(false); return; }
      setErr((e as Error).message);
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }, [collateral, leverage, tenorDays]);

  // Debounced live recompute. Changing inputs invalidates any "activated" demo state.
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

  return (
    <Shell
      title="Protected Leverage"
      subtitle="Trade leveraged — without the wipe-out. Read-only demo."
      updatedIso={bundle?.as_of}
      onSignOut={() => { clearToken("admin"); setAuthed(false); }}
    >
      <div style={{ maxWidth: 560, margin: "0 auto" }}>
        {/* 1 · Position */}
        <Card>
          <SectionLabel>Your position</SectionLabel>
          <Row>
            <label style={lbl}>Collateral</label>
            <div style={{ flex: 1, position: "relative" }}>
              <span style={{ position: "absolute", left: 10, top: 9, color: C.muted, fontSize: 14 }}>$</span>
              <input
                type="number" min={10} step={50} value={collateral}
                onChange={(e) => setCollateral(Math.max(10, Number(e.target.value) || 10))}
                style={{ ...input, paddingLeft: 22 }}
              />
            </div>
            <span style={{ color: C.muted, fontSize: 11 }}>USDC</span>
          </Row>
          <Row>
            <label style={lbl}>Leverage <b style={{ color: C.text }}>{leverage}×</b></label>
            <input type="range" min={1} max={MAX_LEV} step={1} value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))} style={{ flex: 1, accentColor: C.blue }} />
            <span style={{ color: C.muted, fontSize: 11, width: 44, textAlign: "right" }}>max {MAX_LEV}×</span>
          </Row>
          {pos && (
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              You control <b style={{ color: C.text }}>{usd(pos.notional_usdc)}</b> of BTC at {leverage}× (spot {usd(pos.spot)}).
            </div>
          )}
        </Card>

        {err && <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 12, borderRadius: 6, marginBottom: 14 }}>{err}</div>}

        {/* 2 · Before / after — the centerpiece */}
        {pos && sel?.available && (
          <Card>
            <SectionLabel>What protection does {loading && <span style={{ color: C.muted, fontWeight: 400 }}> · pricing…</span>}</SectionLabel>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <BeforeAfter
                tone="bad" heading="Without protection"
                big={`Liquidated at ${usd(pos.liquidation_price)}`}
                lines={[`A ${pct(pos.liq_drop_pct)} drop wipes you out`, `You lose your full ${usd(pos.margin_usdc)}`]}
              />
              <BeforeAfter
                tone="good" heading="With protection"
                big="Can't be wiped out"
                lines={[`Worst case ${usd(sel.max_loss_usdc)}`, "Your upside stays yours"]}
              />
            </div>
          </Card>
        )}

        {/* 3 · Choose floor */}
        {pos && (
          <Card>
            <SectionLabel>Choose your protection</SectionLabel>
            <div style={{ display: "grid", gap: 8 }}>
              {tiers.map((t, i) => (
                <TierRow key={t.margin_fraction} tier={t} selected={selected === i} onClick={() => t.available && (setSelected(i), setActivated(false))} />
              ))}
            </div>
          </Card>
        )}

        {/* 4 · Confirm + simulate */}
        {pos && sel?.available && (
          <Card highlight>
            <SectionLabel>Confirm</SectionLabel>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              <div style={{ fontSize: 13, color: C.text, lineHeight: 1.6 }}>
                Floor your worst case at <b style={{ color: C.green }}>{usd(sel.max_loss_usdc)}</b> for{" "}
                <b>{usd2(sel.put_cost_usdc)}</b> <span style={{ color: C.muted }}>({usd2(sel.cost_per_day_usdc)}/day, {bundle?.tenor_days}d)</span>.
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

            {activated && (
              <Simulator pos={pos} tier={sel} dropPct={simDropPct} onDrop={setSimDropPct} />
            )}
          </Card>
        )}

        {/* details (tucked away) */}
        {bundle && (
          <div style={{ marginTop: 8, textAlign: "center" }}>
            <span onClick={() => setShowDetails((s) => !s)} style={{ color: C.muted, fontSize: 11, cursor: "pointer", textDecoration: "underline" }}>
              {showDetails ? "Hide details" : "How it's priced"}
            </span>
            {showDetails && (
              <div style={{ marginTop: 10, fontSize: 11, color: C.muted, background: C.panel, borderRadius: 6, padding: 12, textAlign: "left", overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace" }}>
                  <thead><tr style={{ textAlign: "left", color: C.muted }}>
                    <th style={td}>Tier</th><th style={td}>Floor</th><th style={td}>Strike</th><th style={td}>Venue</th><th style={td}>Premium</th>
                  </tr></thead>
                  <tbody>
                    {tiers.map((t) => (
                      <tr key={t.margin_fraction} style={{ borderTop: `1px solid ${C.border}`, color: t.available ? C.text : "#555" }}>
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
        )}
      </div>
    </Shell>
  );
}

/** Interactive "drag a BTC drop and watch the floor hold." Pure client-side math. */
function Simulator({ pos, tier, dropPct, onDrop }: { pos: PositionCard; tier: FloorTier; dropPct: number; onDrop: (v: number) => void }) {
  const price = pos.spot * (1 - dropPct);
  const size = pos.size_btc;
  const perpPnl = (price - pos.spot) * size;
  // Unprotected: liquidation forfeits the full margin.
  const liquidated = price <= pos.liquidation_price;
  const unprotectedPnl = liquidated ? -pos.margin_usdc : perpPnl;
  // Protected (integrated): put catches you — loss flattens at the floor, never liquidated.
  const premium = tier.put_cost_usdc ?? 0;
  const strike = tier.floor_strike;
  const protectedPnl = perpPnl + Math.max(0, strike - price) * size - premium;

  return (
    <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
        Simulate a BTC drop: <b style={{ color: C.text }}>−{pct(dropPct)}</b> → {usd(price)}
      </div>
      <input type="range" min={0} max={0.25} step={0.005} value={dropPct}
        onChange={(e) => onDrop(Number(e.target.value))} style={{ width: "100%", accentColor: C.red }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
        <SimBox tone="bad" heading="Unprotected"
          big={liquidated ? "LIQUIDATED" : usd(unprotectedPnl)}
          sub={liquidated ? `lost your full ${usd(pos.margin_usdc)}` : "P&L"} />
        <SimBox tone="good" heading="Protected"
          big={usd(protectedPnl)}
          sub={price <= strike ? "floor holding — capped" : "P&L (floor armed)"} />
      </div>
    </div>
  );
}

// ── presentational helpers ──
const td: React.CSSProperties = { padding: "5px 8px" };
const lbl: React.CSSProperties = { width: 92, fontSize: 13, color: C.muted };
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

function BeforeAfter({ tone, heading, big, lines }: { tone: "good" | "bad"; heading: string; big: string; lines: string[] }) {
  const col = tone === "good" ? C.green : C.red;
  return (
    <div style={{ background: col + "10", border: `1px solid ${col}33`, borderRadius: 8, padding: 14 }}>
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{heading}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: col, marginBottom: 8 }}>{big}</div>
      {lines.map((l, i) => <div key={i} style={{ fontSize: 12, color: C.text, lineHeight: 1.5 }}>{l}</div>)}
    </div>
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
  const disabled = !tier.available;
  const name = tierName(tier.margin_fraction);
  return (
    <div onClick={onClick} style={{
      padding: "12px 14px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
      background: disabled ? "#141414" : selected ? C.green + "12" : C.panel2,
      border: `1px solid ${selected && !disabled ? C.green + "88" : "#333"}`, opacity: disabled ? 0.5 : 1,
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12
    }}>
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: disabled ? "#666" : C.text }}>
          {name}
          {tier.recommended && !disabled && <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>recommended</span>}
        </div>
        <div style={{ fontSize: 12, color: disabled ? "#666" : C.muted, marginTop: 3 }}>
          {tier.available ? `Worst case ${usd(tier.max_loss_usdc)}` : tier.unavailable_reason}
        </div>
      </div>
      {tier.available && (
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.green }}>{usd2(tier.put_cost_usdc)}</div>
          <div style={{ fontSize: 10, color: C.muted }}>{usd2(tier.cost_per_day_usdc)}/day</div>
        </div>
      )}
    </div>
  );
}
