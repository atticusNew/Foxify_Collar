/**
 * One read of one public order book: a single attempt, with the times that say how old the
 * answer is. Public market data only; no credentials, no orders.
 *
 * Why a single attempt: the pairs page re-reads every book each cycle, so the next cycle is the
 * retry. Retrying inside the cycle holds every other book in it while one market answers 404
 * (Polymarket US does that for minutes after a contract opens), and ages all of them.
 */

export type BookReadFailureKind = "http" | "timeout" | "unreachable";

/** A book that did not answer. `url` is for the operator and the logs, never for the page. */
export class BookReadError extends Error {
  readonly kind: BookReadFailureKind;
  readonly status: number | null;
  readonly url: string;
  /** seconds the venue's cache had held this answer (HTTP Age), when it said */
  readonly cacheAgeSec: number | null;

  constructor(kind: BookReadFailureKind, url: string, opts: { status?: number | null; cacheAgeSec?: number | null; detail?: string } = {}) {
    super(kind === "http" ? `HTTP ${opts.status ?? "error"}` : kind === "timeout" ? "timed out" : opts.detail || "no connection");
    this.name = "BookReadError";
    this.kind = kind;
    this.status = opts.status ?? null;
    this.url = url;
    this.cacheAgeSec = opts.cacheAgeSec ?? null;
  }
}

/** What a read says about its own age, beside the book itself. */
export interface BookStamp {
  /** when the venue answered our request, our clock, ms */
  fetchedAtMs: number;
  /**
   * Seconds the venue's cache says it had already held the answer (the HTTP Age header); null
   * when the answer carried none. Both venues front their public APIs with a CDN; Polymarket US
   * serves its book with `cache-control: public, max-age=30`.
   */
  cacheAgeSec: number | null;
  /** the venue's own stamp on the data, ms; null when the venue gives none */
  venueAtMs: number | null;
  /** the venue's state for the market, where it says (Polymarket US: MARKET_STATE_OPEN) */
  state: string | null;
}

export interface ReadOnceOptions {
  timeoutMs?: number;
  /** test seam */
  clock?: () => number;
}

const DEFAULT_TIMEOUT_MS = 8000;

function ageHeader(res: Response): number | null {
  const raw = res.headers?.get?.("age");
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** GET one JSON document once. Throws `BookReadError`; never retries. */
export async function fetchJsonOnce(
  url: string,
  fetchImpl: typeof fetch = fetch,
  opts: ReadOnceOptions = {},
): Promise<{ data: unknown; fetchedAtMs: number; cacheAgeSec: number | null }> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const clock = opts.clock ?? Date.now;
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // raced as well as aborted: a fetch that ignores the signal must still end the wait
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new BookReadError("timeout", url));
    }, timeoutMs);
  });
  const attempt = (async () => {
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: { accept: "application/json", "user-agent": "atticus-event-demo" }, signal: abort.signal });
    } catch (err) {
      if (abort.signal.aborted) throw new BookReadError("timeout", url);
      throw new BookReadError("unreachable", url, { detail: (err as Error).message?.slice(0, 120) });
    }
    const cacheAgeSec = ageHeader(res);
    if (!res.ok) throw new BookReadError("http", url, { status: res.status, cacheAgeSec });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new BookReadError("unreachable", url, { detail: "answer was not JSON" });
    }
    return { data, fetchedAtMs: clock(), cacheAgeSec };
  })();
  // a late rejection after the deadline won is expected and must not surface as unhandled
  attempt.catch(() => {});
  try {
    return await Promise.race([attempt, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
