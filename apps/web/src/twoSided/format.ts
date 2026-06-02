/** Formatting helpers shared by the two-sided dashboards. */

export const fmtUsd = (n: number | null | undefined, decimals = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
};

export const fmtSignedUsd = (n: number | null | undefined, decimals = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n >= 0 ? "+" : ""}${fmtUsd(n, decimals)}`;
};

export const fmtPct = (n: number | null | undefined, decimals = 2): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(decimals)}%`;
};

export const fmtNum = (n: number | null | undefined, decimals = 0): string => {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
};

export const fmtRelative = (iso: string | null | undefined): string => {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const ago = Date.now() - t;
  if (ago < 0) return "just now";
  if (ago < 60_000) return `${Math.floor(ago / 1000)}s ago`;
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)}h ago`;
  return `${Math.floor(ago / 86_400_000)}d ago`;
};

export const fmtHours = (h: number | null | undefined): string => {
  if (h == null || !Number.isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 48) return `${h.toFixed(1)}h`;
  return `${(h / 24).toFixed(1)}d`;
};

export const pnlColor = (n: number | null | undefined): string =>
  n == null ? "#bbb" : n > 0 ? "#69d171" : n < 0 ? "#ff6b6b" : "#bbb";

export const short = (id: string | null | undefined, n = 8): string => (id ? id.slice(0, n) : "—");

/** Human label for a cell structure code from /foxify/v2/cells. */
export const structureLabel = (s: string | null | undefined): string => {
  switch (s) {
    case "atm_straddle": return "ATM straddle";
    case "otm_strangle": return "OTM strangle";
    case "itm_guts_strangle": return "ITM guts strangle";
    default: return s ?? "—";
  }
};
