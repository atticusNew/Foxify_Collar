/**
 * EARN & PROTECT OUTBOUND LINKS — the perp site points at sister surfaces that live on other
 * services (the perp track record, the prediction-market demo, its record). Each one is an
 * env-configured URL that FAILS CLOSED: the link renders only while that service answers its
 * /healthz, so a retail page never sends a visitor to a "Not Found" or a Render error page because
 * a service was renamed, not yet created, or down. Probed at boot and on a timer by the service;
 * an empty env value turns the link off for good.
 *
 * Pure module: the service owns the schedule and passes its fetch.
 */

export type ProbeFetch = (url: string, init: { signal: AbortSignal; redirect: "follow" }) => Promise<{ ok: boolean; status: number }>;

export class OutboundLink {
  /** Normalized URL (no trailing slash); "" when the link is switched off. */
  readonly url: string;
  readonly label: string;
  private alive = false;

  constructor(label: string, raw: string | undefined, fallback: string) {
    this.label = label;
    this.url = (raw ?? fallback).trim().replace(/\/+$/, "");
  }

  /** Configured with a real http(s) URL (as opposed to switched off). */
  get configured(): boolean {
    return /^https?:\/\//.test(this.url);
  }

  /** The href to render, or "" when the link must stay hidden (off, or the service is down). */
  get href(): string {
    return this.configured && this.alive ? this.url : "";
  }

  get isAlive(): boolean {
    return this.alive;
  }

  /** Probe /healthz; logs only on a state change so a steady service is silent. */
  async probe(fetchFn: ProbeFetch = fetch as unknown as ProbeFetch, timeoutMs = 6000, log: (line: string) => void = console.log): Promise<boolean> {
    if (!this.configured) return false;
    const was = this.alive;
    try {
      const r = await fetchFn(`${this.url}/healthz`, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
      this.alive = r.ok;
      if (was !== this.alive) log(`[demo] ${this.label} link ${this.alive ? "ON" : "OFF"} · ${this.url} answered ${r.status}`);
    } catch (e) {
      this.alive = false;
      if (was) log(`[demo] ${this.label} link OFF · ${this.url} unreachable (${(e as Error).message})`);
    }
    return this.alive;
  }
}
