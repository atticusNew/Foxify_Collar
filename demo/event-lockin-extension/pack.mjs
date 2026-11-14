#!/usr/bin/env node
// Production build of the extension: the same files, with the local preview matches and
// permissions stripped from the manifest and the stand-in boards left out. Writes
// dist/lock-in-<version>/ and, when `zip` is on the path, dist/lock-in-<version>.zip for the
// Chrome Web Store upload. Run from this folder: node pack.mjs
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, "manifest.json"), "utf8"));
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/;

manifest.host_permissions = manifest.host_permissions.filter((h) => !LOCAL.test(h));
for (const cs of manifest.content_scripts) cs.matches = cs.matches.filter((m) => !LOCAL.test(m));

const out = join(here, "dist", `lock-in-${manifest.version}`);
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const f of ["content.js", "content.css", "background.js", "options.html", "options.js", "PRIVACY.md"]) cpSync(join(here, f), join(out, f));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// the content script must not carry a local service URL
const content = readFileSync(join(out, "content.js"), "utf8");
if (/127\.0\.0\.1|localhost/.test(content.split("\n").find((l) => l.includes("const DEFAULTS")) || "")) {
  throw new Error("content.js DEFAULTS points at a local service; rebuild from the repo's content.js");
}

let zip = null;
try {
  execSync("zip -v", { stdio: "ignore" });
  zip = `${out}.zip`;
  rmSync(zip, { force: true });
  execSync(`cd ${JSON.stringify(out)} && zip -qr ${JSON.stringify(zip)} .`);
} catch {
  zip = null;
}
console.log(`built ${out}${zip ? ` and ${zip}` : " (no zip on the path; upload the folder's contents)"}`);
console.log(`matches: ${manifest.content_scripts[0].matches.join(", ")}`);
console.log(`host permissions: ${manifest.host_permissions.join(", ")}`);
if (!existsSync(join(out, "PRIVACY.md"))) throw new Error("PRIVACY.md missing");
