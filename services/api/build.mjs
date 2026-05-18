// esbuild bundle for services/api → dist/server.js
//
// Externalizes only published npm packages. Workspace packages
// (@foxify/connectors, @foxify/hedging) are bundled in because they
// ship as TypeScript source and node cannot resolve them at runtime.
//
// Fast cold-start on Render: ~1s build, ~1s boot (no tsx parse cost).

import { build } from "esbuild";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8"));

// All npm dependencies (declared in package.json). Workspace packages
// in dependencies (those starting with "@foxify/") are intentionally
// EXCLUDED from externals so esbuild bundles their TS source.
const externals = Object.keys(pkg.dependencies ?? {})
  .concat(Object.keys(pkg.devDependencies ?? {}))
  .filter((name) => !name.startsWith("@foxify/"));

mkdirSync(resolve(__dirname, "dist"), { recursive: true });

await build({
  entryPoints: [resolve(__dirname, "src/server.ts")],
  outfile: resolve(__dirname, "dist/server.js"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  external: externals,
  logLevel: "info",
  // Banner: enable __dirname / __filename / require() in ESM bundle
  // (some deps do CJS interop at runtime).
  banner: {
    js: [
      "import { createRequire as __cR } from 'node:module';",
      "import { fileURLToPath as __fU } from 'node:url';",
      "import { dirname as __dN } from 'node:path';",
      "const require = __cR(import.meta.url);",
      "const __filename = __fU(import.meta.url);",
      "const __dirname = __dN(__filename);"
    ].join("\n")
  }
});

console.log("[build] services/api → dist/server.js ✓");
