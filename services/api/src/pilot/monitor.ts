import type { BullishTradingClient, BullishAssetBalance } from "./bullish";
import { dispatchAlert } from "./alertDispatcher";

export type AlertLevel = "info" | "warning" | "critical";

export type PilotAlert = {
  level: AlertLevel;
  code: string;
  message: string;
  timestamp: string;
  details?: Record<string, unknown>;
};

export type TreasurySnapshot = {
  timestamp: string;
  usdcBalance: string;
  btcBalance: string;
  allBalances: BullishAssetBalance[];
};

export type MonitorConfig = {
  treasuryWarningThresholdUsd: number;
  treasuryCriticalThresholdUsd: number;
  fillFailureAlertAfterCount: number;
  maxConsecutiveFillFailures: number;
  enabled: boolean;
};

type FillRecord = {
  orderId: string;
  symbol: string;
  status: "filled" | "rejected" | "timeout" | "error";
  timestamp: string;
  premium: number;
  hedgeCost: number;
  spread: number;
};

const DEFAULT_MONITOR_CONFIG: MonitorConfig = {
  treasuryWarningThresholdUsd: 10_000,
  treasuryCriticalThresholdUsd: 5_000,
  fillFailureAlertAfterCount: 3,
  maxConsecutiveFillFailures: 5,
  enabled: true
};

export class PilotMonitor {
  private alerts: PilotAlert[] = [];
  private fillHistory: FillRecord[] = [];
  private consecutiveFailures = 0;
  private lastTreasurySnapshot: TreasurySnapshot | null = null;
  private config: MonitorConfig;

  constructor(config?: Partial<MonitorConfig>) {
    this.config = { ...DEFAULT_MONITOR_CONFIG, ...config };
  }

  private emit(alert: PilotAlert): void {
    this.alerts.push(alert);
    if (this.alerts.length > 500) {
      this.alerts = this.alerts.slice(-250);
    }
    const prefix = alert.level === "critical" ? "[CRITICAL]" : alert.level === "warning" ? "[WARNING]" : "[INFO]";
    console.log(`${prefix} [PilotMonitor] ${alert.code}: ${alert.message}`);
    // R7 — Fan out to configured webhook destinations (Telegram / Slack /
    // Discord / generic). Best-effort, non-blocking: failures inside the
    // dispatcher never propagate; the caller's program flow is unaffected.
    void dispatchAlert(alert).catch((err) => {
      console.warn(`[PilotMonitor] alert dispatch failed: ${err?.message || err}`);
    });
  }

  /**
   * R7 — Public entry-point for any subsystem (hedge manager, trigger
   * monitor, activate path, scheduler) to surface an alert. Fans out to
   * webhooks via the dispatcher and stores in the in-memory ring buffer
   * for /pilot/monitor/alerts visibility.
   *
   * Use this instead of calling console.warn directly when the event is
   * something an operator would want to see in Telegram/Slack.
   */
  recordEvent(alert: Omit<PilotAlert, "timestamp"> & { timestamp?: string }): void {
    this.emit({
      timestamp: alert.timestamp || new Date().toISOString(),
      ...alert
    });
  }

  recordFill(record: FillRecord): void {
    this.fillHistory.push(record);
    if (this.fillHistory.length > 1000) {
      this.fillHistory = this.fillHistory.slice(-500);
    }

    if (record.status === "filled") {
      this.consecutiveFailures = 0;
      if (record.spread < 0) {
        this.emit({
          level: "warning",
          code: "negative_spread",
          message: `Hedge cost exceeded premium by $${Math.abs(record.spread).toFixed(2)} on ${record.symbol}`,
          timestamp: record.timestamp,
          details: record as unknown as Record<string, unknown>
        });
      }
    } else {
      this.consecutiveFailures += 1;
      this.emit({
        level: this.consecutiveFailures >= this.config.maxConsecutiveFillFailures ? "critical" : "warning",
        code: "fill_failure",
        message: `Hedge fill ${record.status} for ${record.symbol} (${this.consecutiveFailures} consecutive failures)`,
        timestamp: record.timestamp,
        details: record as unknown as Record<string, unknown>
      });

      if (this.consecutiveFailures >= this.config.maxConsecutiveFillFailures) {
        this.emit({
          level: "critical",
          code: "fill_circuit_breaker",
          message: `${this.consecutiveFailures} consecutive fill failures -- hedging may be impaired`,
          timestamp: record.timestamp
        });
      }
    }
  }

  async checkTreasuryBalance(client: BullishTradingClient): Promise<TreasurySnapshot> {
    const balances = await client.getAssetBalances();
    const usdc = balances.find((b) => b.assetSymbol === "USDC" || b.assetSymbol === "USD");
    const btc = balances.find((b) => b.assetSymbol === "BTC");
    const snapshot: TreasurySnapshot = {
      timestamp: new Date().toISOString(),
      usdcBalance: usdc?.availableQuantity || "0",
      btcBalance: btc?.availableQuantity || "0",
      allBalances: balances
    };
    this.lastTreasurySnapshot = snapshot;

    const usdcValue = parseFloat(snapshot.usdcBalance);
    if (Number.isFinite(usdcValue)) {
      if (usdcValue < this.config.treasuryCriticalThresholdUsd) {
        this.emit({
          level: "critical",
          code: "treasury_critical",
          message: `USDC balance $${usdcValue.toFixed(2)} below critical threshold $${this.config.treasuryCriticalThresholdUsd}`,
          timestamp: snapshot.timestamp,
          details: { usdcBalance: usdcValue, threshold: this.config.treasuryCriticalThresholdUsd }
        });
      } else if (usdcValue < this.config.treasuryWarningThresholdUsd) {
        this.emit({
          level: "warning",
          code: "treasury_low",
          message: `USDC balance $${usdcValue.toFixed(2)} below warning threshold $${this.config.treasuryWarningThresholdUsd}`,
          timestamp: snapshot.timestamp,
          details: { usdcBalance: usdcValue, threshold: this.config.treasuryWarningThresholdUsd }
        });
      }
    }

    return snapshot;
  }

  getRecentAlerts(limit = 50): PilotAlert[] {
    return this.alerts.slice(-limit);
  }

  getStatus(): {
    healthy: boolean;
    consecutiveFailures: number;
    totalFills: number;
    totalFailures: number;
    fillSuccessRate: string;
    lastTreasury: TreasurySnapshot | null;
    recentAlerts: PilotAlert[];
    spreadStats: { avgSpread: string; minSpread: string; maxSpread: string } | null;
  } {
    const filled = this.fillHistory.filter((f) => f.status === "filled");
    const failed = this.fillHistory.filter((f) => f.status !== "filled");
    const healthy =
      this.consecutiveFailures < this.config.maxConsecutiveFillFailures &&
      !this.alerts.some(
        (a) =>
          a.level === "critical" &&
          Date.now() - Date.parse(a.timestamp) < 300_000
      );

    const spreads = filled.map((f) => f.spread).filter((s) => Number.isFinite(s));
    const spreadStats = spreads.length > 0
      ? {
          avgSpread: (spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(2),
          minSpread: Math.min(...spreads).toFixed(2),
          maxSpread: Math.max(...spreads).toFixed(2)
        }
      : null;

    return {
      healthy,
      consecutiveFailures: this.consecutiveFailures,
      totalFills: filled.length,
      totalFailures: failed.length,
      fillSuccessRate:
        this.fillHistory.length > 0
          ? ((filled.length / this.fillHistory.length) * 100).toFixed(1) + "%"
          : "n/a",
      lastTreasury: this.lastTreasurySnapshot,
      recentAlerts: this.alerts.slice(-10),
      spreadStats
    };
  }

  resetConsecutiveFailures(): void {
    this.consecutiveFailures = 0;
  }
}

export const parseMonitorConfig = (): MonitorConfig => ({
  treasuryWarningThresholdUsd: Math.max(
    0,
    Number(process.env.PILOT_MONITOR_TREASURY_WARNING_USD || "10000")
  ),
  treasuryCriticalThresholdUsd: Math.max(
    0,
    Number(process.env.PILOT_MONITOR_TREASURY_CRITICAL_USD || "5000")
  ),
  fillFailureAlertAfterCount: Math.max(
    1,
    Number(process.env.PILOT_MONITOR_FILL_FAILURE_ALERT_COUNT || "3")
  ),
  maxConsecutiveFillFailures: Math.max(
    1,
    Number(process.env.PILOT_MONITOR_MAX_CONSECUTIVE_FAILURES || "5")
  ),
  enabled: String(process.env.PILOT_MONITOR_ENABLED || "true").trim().toLowerCase() !== "false"
});
