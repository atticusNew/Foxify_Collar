/** Shared dark-theme widgets for the two-sided cooperative-volume dashboards. */

import { useState, type ReactNode, type CSSProperties } from "react";
import { setToken, type Role } from "./api";

const C = {
  bg: "#0a0a0a",
  panel: "#1a1a1a",
  panel2: "#222",
  border: "#2a2a2a",
  text: "#ddd",
  muted: "#888",
  green: "#69d171",
  red: "#ff6b6b",
  amber: "#ffa500",
  blue: "#0aa"
};
export const COLORS = C;

export function TokenGate({ role, title, onSubmit }: { role: Role; title: string; onSubmit: () => void }) {
  const [token, setTok] = useState("");
  const submit = () => {
    if (!token.trim()) return;
    setToken(role, token.trim());
    onSubmit();
  };
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text }}>
      <div style={{ padding: 40, maxWidth: 460, margin: "60px auto", fontFamily: "monospace" }}>
        <h2 style={{ margin: "0 0 16px" }}>{title}</h2>
        <p style={{ color: C.muted, fontSize: 13, marginBottom: 16 }}>
          Paste your {role === "foxify" ? "Foxify" : "Atticus admin"} token (provided by Atticus).
          Stored locally in this browser. To rotate, sign out and re-enter.
        </p>
        <input
          type="password"
          autoFocus
          placeholder="paste token here"
          value={token}
          onChange={(e) => setTok(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          style={{ width: "100%", padding: "10px 12px", fontSize: 14, fontFamily: "monospace", background: C.panel2, color: C.green, border: "1px solid #444", borderRadius: 4, boxSizing: "border-box" }}
        />
        <button onClick={submit} disabled={!token.trim()}
          style={{ marginTop: 12, padding: "10px 16px", background: "#0066cc", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}>
          Enter
        </button>
      </div>
    </div>
  );
}

export function Shell({ title, subtitle, updatedIso, onSignOut, children }: {
  title: string; subtitle?: string; updatedIso?: string | null; onSignOut: () => void; children: ReactNode;
}) {
  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, padding: 16, fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <h1 style={{ fontSize: 18, margin: 0 }}>{title}</h1>
          {subtitle && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{subtitle}</div>}
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          {updatedIso ? new Date(updatedIso).toLocaleTimeString() : ""}
          <span onClick={onSignOut} style={{ marginLeft: 12, color: C.blue, cursor: "pointer", textDecoration: "underline" }}>sign out</span>
        </div>
      </div>
      {children}
    </div>
  );
}

export function Panel({ title, right, children, style }: { title?: string; right?: ReactNode; children: ReactNode; style?: CSSProperties }) {
  return (
    <div style={{ marginBottom: 16, ...style }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          {title && <h3 style={{ margin: 0, color: C.text, fontSize: 14 }}>{title}</h3>}
          {right}
        </div>
      )}
      <div style={{ background: C.panel, borderRadius: 6, padding: 12, overflowX: "auto" }}>{children}</div>
    </div>
  );
}

export function StatGrid({ children, cols = 4 }: { children: ReactNode; cols?: number }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: 12, padding: 12, background: C.panel, borderRadius: 6, marginBottom: 16, fontSize: 13, color: C.text }}>
      {children}
    </div>
  );
}

export function Stat({ label, value, sub, color }: { label: string; value: ReactNode; sub?: ReactNode; color?: string }) {
  return (
    <div>
      <div style={{ color: C.muted, fontSize: 11 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color ?? C.text }}>{value}</div>
      {sub != null && <div style={{ fontSize: 10, color: C.muted }}>{sub}</div>}
    </div>
  );
}

export function Pill({ text, color }: { text: string; color: string }) {
  return (
    <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 10, fontSize: 11, background: `${color}22`, color, border: `1px solid ${color}55` }}>
      {text}
    </span>
  );
}

export function ErrorBar({ msg }: { msg?: string | null }) {
  if (!msg) return null;
  return <div style={{ padding: "10px 16px", background: "#3a1010", color: C.red, fontSize: 12, marginBottom: 16, borderRadius: 6 }}>{msg}</div>;
}

export function Empty({ text }: { text: string }) {
  return <div style={{ color: "#666", fontSize: 12, padding: "8px 0" }}>{text}</div>;
}

/** Minimal generic table. columns: [{key,label,render?,align?}] */
export type Col<T> = { key: string; label: string; align?: "left" | "right"; render?: (row: T) => ReactNode };
export function Table<T>({ cols, rows, keyOf }: { cols: Col<T>[]; rows: T[]; keyOf: (row: T, i: number) => string }) {
  if (rows.length === 0) return <Empty text="Nothing to show." />;
  return (
    <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
      <thead>
        <tr style={{ color: C.muted, textAlign: "left" }}>
          {cols.map((c) => <th key={c.key} style={{ padding: "6px 8px", textAlign: c.align ?? "left" }}>{c.label}</th>)}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={keyOf(row, i)} style={{ borderTop: `1px solid ${C.border}`, color: C.text }}>
            {cols.map((c) => (
              <td key={c.key} style={{ padding: "6px 8px", textAlign: c.align ?? "left" }}>
                {c.render ? c.render(row) : String((row as Record<string, unknown>)[c.key] ?? "—")}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { id: string; label: string }[]; active: string; onChange: (id: string) => void }) {
  return (
    <div style={{ display: "flex", gap: 4, marginBottom: 16, borderBottom: `1px solid ${C.border}`, flexWrap: "wrap" }}>
      {tabs.map((t) => (
        <div key={t.id} onClick={() => onChange(t.id)}
          style={{ padding: "8px 14px", cursor: "pointer", fontSize: 13, color: active === t.id ? C.text : C.muted, borderBottom: active === t.id ? "2px solid #0066cc" : "2px solid transparent", fontWeight: active === t.id ? 700 : 400 }}>
          {t.label}
        </div>
      ))}
    </div>
  );
}
