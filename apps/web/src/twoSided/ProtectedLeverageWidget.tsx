/**
 * Protected Leverage — read-only floor widget (Phase 1, Sai exchange sales artifact / sandbox).
 *
 * Load a leveraged position (manual), see exactly where it liquidates, then pick a one-tap
 * protective-PUT floor framed the way a trader thinks: "risk only X% of my margin." Each tier
 * is priced live as the cheapest LONG PUT across Bullish / Deribit / OKX.
 *
 * Honest framing (cross-venue): the perp still liquidates on the exchange; the separately-held
 * put bounds NET loss. NOT "no liquidation" — that needs Phase-2 exchange margin integration.
 *
 * READ-ONLY. Calls GET /admin/foxify/v2/floor-quote/tiers. Admin-token gated for now (a
 * dedicated read-only prospect token/endpoint is a follow-up).
 */

import { useEffect, useState, useCallback } from "react";
import { adminGet, getToken, clearToken, UnauthorizedError } from "./api";
import { TokenGate, Shell, COLORS as C } from "./widgets";

type FloorTier = {
  margin_fraction: number;
  label: string;
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
  headline: string;
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
  liq_summary: string;
};

type Bundle = {
  as_of: string;
  position: PositionCard;
  tenor_days: number;
  tiers: FloorTier[];
  note: string;
};

const usd = (x: number | null | undefined) =>
  x == null ? "—" : `$${Math.round(x).toLocaleString()}`;
const usd2 = (x: number | null | undefined) =>
  x == null ? "—" : `$${x.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;

const TENORS = [1, 3, 7];
const MAX_LEV = 40;

export function ProtectedLeverageWidget() {
  const [authed, setAuthed] = useState(() => !!getToken("admin"));
  const [sizeBtc, setSizeBtc] = useState(1);
  const [leverage, setLeverage] = useState(10);
  const [tenorDays, setTenorDays] = useState(3);
  const [selected, setSelected] = useState<number | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!getToken("admin")) { setAuthed(false); return; }
    setLoading(true);
    setErr(null);
    try {
      const q = `size=${sizeBtc}&leverage=${leverage}&tenor_days=${tenorDays}`;
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
  }, [sizeBtc, leverage, tenorDays]);

  // Debounced live recompute as the trader moves the sliders.
  useEffect(() => {
    if (!authed) return;
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
      subtitle="Trade leveraged — with a hard floor on your worst case. Read-only demo."
      updatedIso={bundle?.as_of}
      onSignOut={() => { clearToken("admin"); setAuthed(false); }}
    >
      <div style={{ maxWidth: 720, margin: "0 auto" }}>
        {/* ── Load your position ── */}
        <Card>
          <SectionLabel>1 · Your position</SectionLabel>
          <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
            <Toggle active label="Long" />
            <Toggle active={false} label="Short (soon)" disabled />
          </div>

          <Row>
            <label style={lblStyle}>Size (BTC)</label>
            <input
              type="number" min={0.01} step={0.1} value={sizeBtc}
              onChange={(e) => setSizeBtc(Math.max(0.01, Number(e.target.value) || 0.01))}
              style={inputStyle}
            />
          </Row>

          <Row>
            <label style={lblStyle}>Leverage <span style={{ color: C.text, fontWeight: 700 }}>{leverage}×</span></label>
            <input
              type="range" min={1} max={MAX_LEV} step={1} value={leverage}
              onChange={(e) => setLeverage(Number(e.target.value))}
              style={{ flex: 1, accentColor: C.blue }}
            />
            <span style={{ color: C.muted, fontSize: 11, width: 40, textAlign: "right" }}>max {MAX_LEV}×</span>
          </Row>

          <Row>
            <label style={lblStyle}>Tenor</label>
            <div style={{ display: "flex", gap: 6 }}>
              {TENORS.map((d) => (
                <Toggle key={d} active={tenorDays === d} label={`${d}d`} onClick={() => setTenorDays(d)} />
              ))}
            </div>
          </Row>
        </Card>

        {err && (
          <div style={{ padding: "10px 14px", background: "#3a1010", color: C.red, fontSize: 12, borderRadius: 6, marginBottom: 14 }}>
            {err}
          </div>
        )}

        {/* ── Position card ── */}
        {pos && (
          <Card>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <Stat label="Spot" value={usd(pos.spot)} />
              <Stat label="Notional" value={usd(pos.notional_usdc)} />
              <Stat label="Margin posted" value={usd(pos.margin_usdc)} />
              <Stat label="Liquidation" value={usd(pos.liquidation_price)} sub={`${pct(pos.liq_drop_pct)} drop`} color={C.red} />
            </div>
            <div style={{ marginTop: 12, fontSize: 12, color: C.amber, lineHeight: 1.5 }}>{pos.liq_summary}</div>
          </Card>
        )}

        {/* ── Floor tiers ── */}
        {pos && (
          <Card>
            <SectionLabel>2 · Pick your floor {loading && <span style={{ color: C.muted, fontWeight: 400 }}> · pricing…</span>}</SectionLabel>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 12 }}>
              How much of your ${Math.round(pos.margin_usdc).toLocaleString()} margin are you willing to risk before protection kicks in? Lower = safer, costs more.
            </div>
            <div style={{ display: "grid", gap: 10 }}>
              {tiers.map((t, i) => (
                <TierButton
                  key={t.margin_fraction}
                  tier={t}
                  selected={selected === i}
                  onClick={() => t.available && setSelected(i)}
                />
              ))}
            </div>
          </Card>
        )}

        {/* ── Chosen summary ── */}
        {sel && sel.available && pos && (
          <Card highlight>
            <SectionLabel>3 · Your protection</SectionLabel>
            <div style={{ fontSize: 14, color: C.text, lineHeight: 1.6 }}>
              You stay leveraged at <b>{pos.leverage}×</b>. If BTC falls past{" "}
              <b style={{ color: C.amber }}>{usd(sel.floor_strike)}</b>, your loss is hard-capped — your
              worst case is <b style={{ color: C.green }}>{usd(sel.max_loss_usdc)}</b> (instead of losing your
              full <b style={{ color: C.red }}>{usd(pos.margin_usdc)}</b> margin, and more on a fast gap).
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginTop: 14 }}>
              <Stat label="Floor cost" value={usd2(sel.put_cost_usdc)} sub={`${usd2(sel.cost_per_day_usdc)}/day`} />
              <Stat label="Worst case" value={usd(sel.max_loss_usdc)} color={C.green} />
              <Stat label="Cheapest venue" value={(sel.venue ?? "—").toUpperCase()} sub={`${bundle?.tenor_days}d tenor`} />
            </div>
          </Card>
        )}

        {/* ── Details / honesty ── */}
        {bundle && (
          <div style={{ marginTop: 8 }}>
            <span
              onClick={() => setShowDetails((s) => !s)}
              style={{ color: C.blue, fontSize: 12, cursor: "pointer", textDecoration: "underline" }}
            >
              {showDetails ? "Hide details" : "Show details"}
            </span>
            {showDetails && (
              <div style={{ marginTop: 10, fontSize: 11, color: C.muted, background: C.panel, borderRadius: 6, padding: 12, overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: "monospace" }}>
                  <thead>
                    <tr style={{ textAlign: "left", color: C.muted }}>
                      <th style={thtd}>Tier</th><th style={thtd}>Floor %</th><th style={thtd}>Strike</th>
                      <th style={thtd}>Venue</th><th style={thtd}>Instrument</th><th style={thtd}>Premium</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tiers.map((t) => (
                      <tr key={t.margin_fraction} style={{ borderTop: `1px solid ${C.border}`, color: t.available ? C.text : "#555" }}>
                        <td style={thtd}>{Math.round(t.margin_fraction * 100)}%</td>
                        <td style={thtd}>{pct(t.floor_pct)}</td>
                        <td style={thtd}>{usd(t.floor_strike)}</td>
                        <td style={thtd}>{t.venue ?? "—"}</td>
                        <td style={thtd}>{t.instrument ?? "—"}</td>
                        <td style={thtd}>{usd2(t.put_cost_usdc)}</td>
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

// ── small presentational helpers ──
const thtd: React.CSSProperties = { padding: "5px 8px" };
const lblStyle: React.CSSProperties = { width: 130, fontSize: 13, color: C.muted };
const inputStyle: React.CSSProperties = {
  flex: 1, padding: "8px 10px", fontSize: 14, background: C.panel2, color: C.text,
  border: `1px solid ${C.border}`, borderRadius: 6, boxSizing: "border-box"
};

function Card({ children, highlight }: { children: React.ReactNode; highlight?: boolean }) {
  return (
    <div style={{
      background: C.panel, borderRadius: 10, padding: 18, marginBottom: 14,
      border: highlight ? `1px solid ${C.green}66` : `1px solid ${C.border}`
    }}>
      {children}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, color: C.text, letterSpacing: 0.4, textTransform: "uppercase", marginBottom: 12 }}>{children}</div>;
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>{children}</div>;
}

function Stat({ label, value, sub, color }: { label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string }) {
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? C.text }}>{value}</div>
      {sub != null && <div style={{ fontSize: 10, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function Toggle({ active, label, onClick, disabled }: { active: boolean; label: string; onClick?: () => void; disabled?: boolean }) {
  return (
    <div
      onClick={disabled ? undefined : onClick}
      style={{
        padding: "6px 14px", borderRadius: 6, fontSize: 13, cursor: disabled ? "not-allowed" : onClick ? "pointer" : "default",
        background: active ? C.blue + "22" : C.panel2, color: disabled ? "#555" : active ? C.blue : C.muted,
        border: `1px solid ${active ? C.blue + "66" : C.border}`, fontWeight: active ? 700 : 400
      }}
    >
      {label}
    </div>
  );
}

function TierButton({ tier, selected, onClick }: { tier: FloorTier; selected: boolean; onClick: () => void }) {
  const disabled = !tier.available;
  return (
    <div
      onClick={onClick}
      style={{
        padding: "14px 16px", borderRadius: 8, cursor: disabled ? "not-allowed" : "pointer",
        background: disabled ? "#141414" : selected ? C.green + "14" : C.panel2,
        border: `1px solid ${selected && !disabled ? C.green + "88" : disabled ? C.border : "#333"}`,
        opacity: disabled ? 0.55 : 1, transition: "background 120ms, border 120ms"
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: disabled ? "#666" : C.text }}>
          {tier.label}
          {tier.recommended && !disabled && (
            <span style={{ marginLeft: 8, fontSize: 10, padding: "2px 7px", borderRadius: 8, background: C.green + "22", color: C.green, border: `1px solid ${C.green}55` }}>
              recommended
            </span>
          )}
        </div>
        {tier.available
          ? <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>{usd(tier.put_cost_usdc)}</div>
          : <div style={{ fontSize: 11, color: "#777" }}>unavailable</div>}
      </div>
      <div style={{ fontSize: 12, color: disabled ? "#666" : C.muted, marginTop: 6, lineHeight: 1.5 }}>
        {tier.available ? tier.headline : tier.unavailable_reason}
      </div>
      {tier.available && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>
          Protected if BTC falls past {usd(tier.floor_strike)} · {(tier.venue ?? "").toUpperCase()}
        </div>
      )}
    </div>
  );
}
