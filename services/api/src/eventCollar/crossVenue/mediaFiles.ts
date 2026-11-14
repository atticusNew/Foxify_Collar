/**
 * Static media for the demo page: the live recording and its poster frame, served from a
 * fixed set of files so the route never reads outside its folder. Byte ranges are honoured
 * (one range at a time) because browsers fetch video that way and seeking depends on it.
 */
import { createReadStream, statSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

/** The files the route may serve, by the name on the URL, with their content types. */
export const MEDIA_FILES: Readonly<Record<string, string>> = {
  "lockin-live.mp4": "video/mp4",
  "lockin-live.jpg": "image/jpeg",
};

export interface MediaRange {
  start: number;
  end: number;
}

/**
 * One satisfiable byte range from a Range header, or null for none / anything but a single
 * `bytes=` range. A suffix range (`bytes=-500`) is the last 500 bytes; an open end runs to the
 * last byte. A start past the end is unsatisfiable and reported as `{ start: -1, end: -1 }`.
 */
export function parseRange(header: string | undefined, size: number): MediaRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  if (m[1] === "") {
    const n = Math.min(size, Number(m[2]));
    return n <= 0 ? { start: -1, end: -1 } : { start: size - n, end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) return { start: -1, end: -1 };
  const end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  return end < start ? { start: -1, end: -1 } : { start, end };
}

/**
 * Serve `/media/<name>` from `dir`. Answers 404 for a name not in MEDIA_FILES or a file that
 * is not on disk, 405 for anything but GET/HEAD, 416 for an unsatisfiable range, 206 for a
 * range and 200 otherwise. Returns false when the path is not a media path at all.
 */
export function serveMedia(req: IncomingMessage, res: ServerResponse, pathname: string, dir: string): boolean {
  if (!pathname.startsWith("/media/")) return false;
  const name = pathname.slice("/media/".length);
  const type = Object.prototype.hasOwnProperty.call(MEDIA_FILES, name) ? MEDIA_FILES[name] : null;
  if (!type) {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return true;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { allow: "GET, HEAD", "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
    return true;
  }
  const path = join(dir, name);
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return true;
  }
  const base: Record<string, string> = {
    "content-type": type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=3600",
  };
  const range = parseRange(typeof req.headers.range === "string" ? req.headers.range : undefined, size);
  if (range && range.start < 0) {
    res.writeHead(416, { ...base, "content-range": `bytes */${size}` });
    res.end();
    return true;
  }
  if (range) {
    res.writeHead(206, { ...base, "content-range": `bytes ${range.start}-${range.end}/${size}`, "content-length": String(range.end - range.start + 1) });
    if (req.method === "HEAD") res.end();
    else createReadStream(path, { start: range.start, end: range.end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, "content-length": String(size) });
  if (req.method === "HEAD") res.end();
  else createReadStream(path).pipe(res);
  return true;
}
