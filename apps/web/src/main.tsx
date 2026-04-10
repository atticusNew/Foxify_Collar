import React, { useState, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { PilotApp } from "./PilotApp";
import { PilotWidget } from "./PilotWidget";
import { AdminDashboardPage } from "./AdminDashboard";
import { TreasuryDashboard } from "./TreasuryDashboard";
import { SimpleSimPilotApp } from "./SimpleSimPilotApp";
import { PILOT_SIMPLE_SIM_WIDGET, PILOT_WIDGET } from "./config";
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

function AppRouter() {
  const path = usePathRoute();

  if (path === "/admin" || path.startsWith("/admin/")) {
    return <AdminDashboardPage />;
  }

  if (path === "/treasury" || path.startsWith("/treasury/")) {
    return <TreasuryDashboard />;
  }

  if (PILOT_SIMPLE_SIM_WIDGET) return <SimpleSimPilotApp />;
  if (PILOT_WIDGET) return <PilotWidget />;
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
