/**
 * Prometheus-style metrics for two-sided cooperative volume facility (PR B3).
 *
 * In-memory only — no external dependency. Format-compatible with Prometheus
 * text exposition format (https://prometheus.io/docs/instrumenting/exposition_formats/).
 *
 * Exposed at GET /metrics. Render-side Prometheus scraper picks them up.
 *
 * Metric types:
 *   Counter — monotonically increasing; resets only on process restart
 *   Gauge   — current value (can go up or down)
 *   Histogram — bucketed count + sum for percentile computation
 *
 * Naming convention: prefix `two_sided_` for all metrics.
 */

export class Metrics {
  private counters = new Map<string, Map<string, number>>(); // name -> labelKey -> value
  private gauges = new Map<string, Map<string, number>>();
  private histograms = new Map<string, Map<string, { buckets: Map<number, number>; sum: number; count: number }>>();

  // ─── Counter ───

  incrementCounter(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const labelKey = this.labelKey(labels);
    if (!this.counters.has(name)) this.counters.set(name, new Map());
    const labelMap = this.counters.get(name)!;
    labelMap.set(labelKey, (labelMap.get(labelKey) ?? 0) + delta);
  }

  // ─── Gauge ───

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const labelKey = this.labelKey(labels);
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    this.gauges.get(name)!.set(labelKey, value);
  }

  incrementGauge(name: string, labels: Record<string, string> = {}, delta = 1): void {
    const labelKey = this.labelKey(labels);
    if (!this.gauges.has(name)) this.gauges.set(name, new Map());
    const labelMap = this.gauges.get(name)!;
    labelMap.set(labelKey, (labelMap.get(labelKey) ?? 0) + delta);
  }

  decrementGauge(name: string, labels: Record<string, string> = {}, delta = 1): void {
    this.incrementGauge(name, labels, -delta);
  }

  // ─── Histogram ───

  static readonly DEFAULT_BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}, buckets: number[] = Metrics.DEFAULT_BUCKETS): void {
    const labelKey = this.labelKey(labels);
    if (!this.histograms.has(name)) this.histograms.set(name, new Map());
    const labelMap = this.histograms.get(name)!;
    let h = labelMap.get(labelKey);
    if (!h) {
      const bucketMap = new Map<number, number>();
      for (const b of buckets) bucketMap.set(b, 0);
      h = { buckets: bucketMap, sum: 0, count: 0 };
      labelMap.set(labelKey, h);
    }
    h.sum += value;
    h.count += 1;
    for (const [bound, count] of h.buckets) {
      if (value <= bound) h.buckets.set(bound, count + 1);
    }
  }

  // ─── Snapshot ───

  /** Returns all metric values as a structured object. Useful for tests + diagnostics. */
  snapshot(): {
    counters: Record<string, Record<string, number>>;
    gauges: Record<string, Record<string, number>>;
    histograms: Record<string, Record<string, { buckets: Record<number, number>; sum: number; count: number }>>;
  } {
    const c: Record<string, Record<string, number>> = {};
    for (const [n, m] of this.counters) {
      c[n] = {};
      for (const [k, v] of m) c[n][k] = v;
    }
    const g: Record<string, Record<string, number>> = {};
    for (const [n, m] of this.gauges) {
      g[n] = {};
      for (const [k, v] of m) g[n][k] = v;
    }
    const h: Record<string, Record<string, { buckets: Record<number, number>; sum: number; count: number }>> = {};
    for (const [n, m] of this.histograms) {
      h[n] = {};
      for (const [k, entry] of m) {
        const bk: Record<number, number> = {};
        for (const [bound, count] of entry.buckets) bk[bound] = count;
        h[n][k] = { buckets: bk, sum: entry.sum, count: entry.count };
      }
    }
    return { counters: c, gauges: g, histograms: h };
  }

  /** Reset all metrics. Tests only. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
  }

  // ─── Prometheus text exposition ───

  renderPrometheus(): string {
    const lines: string[] = [];

    // Counters
    for (const [name, labelMap] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [labelKey, value] of labelMap) {
        lines.push(`${name}${labelKey} ${value}`);
      }
    }
    // Gauges
    for (const [name, labelMap] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`);
      for (const [labelKey, value] of labelMap) {
        lines.push(`${name}${labelKey} ${value}`);
      }
    }
    // Histograms
    for (const [name, labelMap] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [labelKey, entry] of labelMap) {
        // Strip {} from labelKey if empty, otherwise insert le label inside
        const labelInner = labelKey.length > 2 ? labelKey.slice(1, -1) + "," : "";
        for (const [bound, count] of entry.buckets) {
          lines.push(`${name}_bucket{${labelInner}le="${bound}"} ${count}`);
        }
        // +Inf bucket = total count
        lines.push(`${name}_bucket{${labelInner}le="+Inf"} ${entry.count}`);
        lines.push(`${name}_sum${labelKey} ${entry.sum}`);
        lines.push(`${name}_count${labelKey} ${entry.count}`);
      }
    }
    return lines.join("\n") + "\n";
  }

  // ─── Helpers ───

  private labelKey(labels: Record<string, string>): string {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return "";
    const parts = keys.map((k) => `${k}="${String(labels[k]).replace(/"/g, '\\"')}"`);
    return `{${parts.join(",")}}`;
  }
}

// ─── Singleton ───

let _instance: Metrics | null = null;

export const getMetrics = (): Metrics => {
  if (!_instance) _instance = new Metrics();
  return _instance;
};

export const __resetMetricsForTests = (): void => {
  if (_instance) _instance.reset();
  _instance = null;
};

// ─── Standard metric names ───

export const METRIC_NAMES = {
  PAIRS_ACTIVATED_TOTAL: "two_sided_pairs_activated_total",
  PAIRS_TRIGGERED_TOTAL: "two_sided_pairs_triggered_total",
  PAIRS_SETTLED_TOTAL: "two_sided_pairs_settled_total",
  PAIRS_CANCELLED_TOTAL: "two_sided_pairs_cancelled_total",
  ACTIVATIONS_BLOCKED_TOTAL: "two_sided_activations_blocked_total",
  EXECUTION_STUCK_TOTAL: "two_sided_execution_stuck_total",
  WEBHOOK_DELIVERY_ATTEMPTS_TOTAL: "two_sided_webhook_delivery_attempts_total",
  WEBHOOK_DELIVERY_SUCCESS_TOTAL: "two_sided_webhook_delivery_success_total",
  ACTIVE_PAIRS: "two_sided_active_pairs",
  UNWIND_QUEUE_DEPTH: "two_sided_unwind_queue_depth",
  FEED_HEALTH: "two_sided_feed_health", // 1=healthy, 0.5=degraded, 0=unavailable
  CURRENT_DVOL: "two_sided_current_dvol",
  CAPITAL_DEPLOYED_USDC: "two_sided_capital_deployed_usdc",
  ACTIVATE_LATENCY_MS: "two_sided_activate_latency_ms",
  UNWIND_LATENCY_MS: "two_sided_unwind_latency_ms",
  SALVAGE_UPLIFT_USDC: "two_sided_salvage_uplift_usdc"
} as const;
