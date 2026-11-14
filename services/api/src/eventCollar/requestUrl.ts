/**
 * THE ADDRESS A REQUEST ASKED FOR.
 *
 * A request names a path on this service: one slash, then the rest. Read any other way, the
 * same text can name another host (`//x/report` is host `x`), or name nothing at all (`//`,
 * `//x:99999/`), and the parser throws. A throw outside a route's own guard ends the process,
 * so one request from anyone would take the service down until the host restarts it.
 *
 * So the address is read as a path and nothing else, and an address that is not one path is
 * refused with a 400 before any route sees it.
 */
import type { ServerResponse } from "node:http";

/** The address as a URL on this service, or null when it is not one path here. Never throws. */
export function requestUrl(target: string | undefined, port: number | string): URL | null {
  const t = target || "/";
  // a path starts with one slash; a full address, `*`, or an empty line is not a path here
  if (!t.startsWith("/")) return null;
  try {
    const url = new URL(`http://localhost:${port}${t}`);
    // `//x` and `/\x` both come out as a path starting with two slashes: a host in disguise
    return url.pathname.startsWith("//") ? null : url;
  } catch {
    return null;
  }
}

export const BAD_ADDRESS_MESSAGE = "This address is not a path on this service. A path starts with one slash, for example /healthz.";

/** The 400 every service gives for an address that is not a path. */
export function refuseBadAddress(res: ServerResponse): void {
  const body = JSON.stringify({ ok: false, error: "bad_address", message: BAD_ADDRESS_MESSAGE });
  res.writeHead(400, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
}
