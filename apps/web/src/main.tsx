import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PilotApp } from "./PilotApp";
import { PilotWidget } from "./PilotWidget";
import { AdminDashboardPage } from "./AdminDashboard";
import { TreasuryDashboard } from "./TreasuryDashboard";
import { TreasuryAdmin } from "./TreasuryAdmin";
import { SimpleSimPilotApp } from "./SimpleSimPilotApp";
import { PILOT_SIMPLE_SIM_WIDGET, PILOT_WIDGET, PILOT_ACCESS_CODE } from "./config";
import "./styles.css";

type ErrorBoundaryState = {
  hasError: boolean;
};

class RootErrorBoundary extends React.Component<React.PropsWithChildren, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("RootErrorBoundary caught render error", error, errorInfo);
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="shell">
          <div className="card">
            <div className="title">Foxify Protect</div>
            <div className="disclaimer danger">
              Something went wrong. Please refresh and try again.
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function usePathRoute() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

const ACCESS_KEY = "foxify_pilot_access";

function PilotAccessGate({ children }: { children: React.ReactNode }) {
  const [code, setCode] = useState("");
  const [granted, setGranted] = useState(() => {
    if (!PILOT_ACCESS_CODE) return true;
    return localStorage.getItem(ACCESS_KEY) === PILOT_ACCESS_CODE;
  });

  if (granted) return <>{children}</>;

  const handleSubmit = () => {
    if (code.trim() === PILOT_ACCESS_CODE) {
      localStorage.setItem(ACCESS_KEY, code.trim());
      setGranted(true);
    }
  };

  return (
    <div className="shell">
      <div className="card" style={{ maxWidth: 400, padding: 24 }}>
        <div style={{ textAlign: "center", marginBottom: 20 }}>
          <img src="https://i.ibb.co/SDwxMqS8/Foxify-200x200.png" alt="" style={{ width: 48, height: 48, borderRadius: 12, marginBottom: 12 }} onError={e => { (e.target as HTMLImageElement).style.display = "none"; }} />
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: 0.2 }}>Foxify Perp Protect</div>
          <div style={{ fontSize: 12, color: "var(--muted)", marginTop: 4 }}>Pilot Access</div>
        </div>
        <input
          type="password"
          placeholder="Access code"
          value={code}
          onChange={e => setCode(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSubmit()}
          style={{ width: "100%", padding: "10px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "var(--card-2)", color: "var(--text)", fontSize: 14, marginBottom: 12, outline: "none", boxSizing: "border-box" }}
          autoFocus
        />
        <button
          onClick={handleSubmit}
          style={{ width: "100%", padding: "10px 0", borderRadius: 8, border: "none", background: "linear-gradient(135deg, var(--accent), var(--accent-2))", color: "#fff", fontSize: 14, fontWeight: 600, cursor: "pointer" }}
        >
          Enter Pilot
        </button>
        <div style={{ textAlign: "center", marginTop: 14, fontSize: 10, color: "var(--muted)", opacity: 0.4 }}>
          Atticus Strategy, Ltd.
        </div>
      </div>
    </div>
  );
}

function AppRouter() {
  const path = usePathRoute();

  if (path === "/admin" || path.startsWith("/admin/")) {
    return <AdminDashboardPage />;
  }

  if (path === "/treasury/admin") {
    return <TreasuryAdmin />;
  }

  if (path === "/treasury" || path.startsWith("/treasury/")) {
    return <TreasuryDashboard />;
  }

  if (PILOT_SIMPLE_SIM_WIDGET) return <PilotAccessGate><SimpleSimPilotApp /></PilotAccessGate>;
  if (PILOT_WIDGET) return <PilotAccessGate><PilotWidget /></PilotAccessGate>;
  return <App />;
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AppRouter />
    </RootErrorBoundary>
  </React.StrictMode>
);
