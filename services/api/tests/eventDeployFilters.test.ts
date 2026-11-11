/**
 * Deploy filters: render-event-demos.yaml lists, per service, the paths a merge may change
 * without Render redeploying that service. A path ignored by mistake leaves a service running
 * old code with no error anywhere, so this test works out what each service's start script
 * really loads and fails if an ignored path covers any of it.
 *
 * What "loads" means here: the files the start script imports (esbuild's own module graph),
 * the files it reads from beside its source at run time, and the files the install and tsx
 * read. The blueprint is read with a small parser of its own so the test adds no dependency;
 * it refuses anything it cannot read rather than guess.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { MEDIA_FILES } from "../src/eventCollar/crossVenue/mediaFiles";

const API_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(API_DIR, "../..");
const BLUEPRINT = "render-event-demos.yaml";
/** startCommand runs in the services/api workspace, so its script path is relative to this. */
const WORKSPACE = "services/api";

// ── the blueprint, as far as this test needs it ───────────────────────────────

interface BlueprintService {
  name: string;
  startCommand: string;
  /** The start script, relative to the repository root. */
  entry: string;
  ignoredPaths: string[];
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** One plain or quoted YAML scalar. Lists in brackets, anchors and aliases are refused. */
function scalar(raw: string, where: string): string {
  const s = raw.trim();
  const quoted = /^"([^"\\]*)"(\s+#.*)?$/.exec(s) ?? /^'([^']*)'(\s+#.*)?$/.exec(s);
  if (quoted) return quoted[1];
  const plain = s.replace(/\s+#.*$/, "");
  if (plain === "" || /^[[{&*!|>'"]/.test(plain)) throw new Error(`${where}: cannot read the value ${JSON.stringify(raw)}`);
  return plain;
}

/**
 * The services of a Render blueprint: name, startCommand and buildFilter.ignoredPaths. Written
 * for this file's layout (services at two spaces, their keys at four) and loud about anything
 * else: a service without a name, a start command or a filter, a start command that is not
 * `tsx <script>.ts`, and any buildFilter key other than ignoredPaths all throw.
 */
function parseBlueprint(text: string): BlueprintService[] {
  const services: BlueprintService[] = [];
  let inServices = false;
  let cur: { name?: string; startCommand?: string; ignoredPaths?: string[]; line: number } | null = null;
  let filterIndent = -1;
  let listKey: string | null = null;

  const finish = (): void => {
    if (!cur) return;
    const where = `service at line ${cur.line}`;
    if (!cur.name) throw new Error(`${where}: no name`);
    if (!cur.startCommand) throw new Error(`${cur.name}: no startCommand`);
    const script = /\btsx\s+(\S+\.ts)\s*$/.exec(cur.startCommand);
    if (!script) throw new Error(`${cur.name}: startCommand is not "tsx <script>.ts": ${cur.startCommand}`);
    if (!cur.ignoredPaths || cur.ignoredPaths.length === 0) throw new Error(`${cur.name}: no buildFilter.ignoredPaths`);
    services.push({ name: cur.name, startCommand: cur.startCommand, entry: `${WORKSPACE}/${script[1]}`, ignoredPaths: cur.ignoredPaths });
    cur = null;
  };

  text.split("\n").forEach((line, i) => {
    const where = `line ${i + 1}`;
    const body = line.trim();
    if (body === "" || body.startsWith("#")) return;
    const indent = indentOf(line);
    if (indent === 0) {
      finish();
      inServices = /^services:\s*(#.*)?$/.test(line);
      return;
    }
    if (!inServices) return;
    if (filterIndent >= 0 && indent <= filterIndent) {
      filterIndent = -1;
      listKey = null;
    }
    if (indent === 2) {
      if (!body.startsWith("- ")) throw new Error(`${where}: expected a service to start with "- "`);
      finish();
      cur = { line: i + 1 };
      return;
    }
    if (!cur) throw new Error(`${where}: content before the first service`);
    if (filterIndent >= 0) {
      const key = /^([A-Za-z]+):\s*(.*)$/.exec(body);
      if (key) {
        if (key[1] !== "ignoredPaths") throw new Error(`${cur.name}: buildFilter may only carry ignoredPaths, found "${key[1]}" at ${where}`);
        if (key[2] !== "" && !key[2].startsWith("#")) throw new Error(`${where}: ignoredPaths must be a block list`);
        if (cur.ignoredPaths) throw new Error(`${cur.name}: ignoredPaths appears twice`);
        cur.ignoredPaths = [];
        listKey = key[1];
        return;
      }
      const item = /^- (.+)$/.exec(body);
      if (item && listKey && cur.ignoredPaths) {
        cur.ignoredPaths.push(scalar(item[1], where));
        return;
      }
      throw new Error(`${where}: cannot read this line inside buildFilter: ${body}`);
    }
    if (indent !== 4) return;
    const key = /^([A-Za-z]+):\s*(.*)$/.exec(body);
    if (!key) return;
    if (key[1] === "name") cur.name = scalar(key[2], where);
    else if (key[1] === "startCommand") cur.startCommand = scalar(key[2], where);
    else if (key[1] === "buildFilter") {
      if (key[2] !== "" && !key[2].startsWith("#")) throw new Error(`${where}: buildFilter must be a block`);
      if (cur.ignoredPaths) throw new Error(`${cur.name}: buildFilter appears twice`);
      filterIndent = indent;
    }
  });
  finish();
  if (services.length === 0) throw new Error("no services found in the blueprint");
  return services;
}

// ── globs, the subset the blueprint uses ──────────────────────────────────────

/**
 * Render's glob rules for the three forms the filters use: a literal segment, `*` (any run of
 * characters inside one segment) and `**` as a whole segment (any number of directories, none
 * included). Anything else Render accepts (`?`, brackets) is refused, so a pattern this test
 * cannot judge never reaches the blueprint unnoticed.
 */
function globToRegExp(glob: string): RegExp {
  if (glob === "" || glob.startsWith("/") || /[?[\]{}!\\]/.test(glob)) throw new Error(`unsupported glob: ${glob}`);
  const segments = glob.split("/");
  let re = "^";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      re += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    if (seg === "" || seg.includes("**")) throw new Error(`unsupported glob: ${glob}`);
    re += seg.split("*").map((lit) => lit.replace(/[.+^$()|]/g, "\\$&")).join("[^/]*") + (last ? "" : "/");
  });
  return new RegExp(`${re}$`);
}

const globMatches = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

/** The first of `globs` that covers `path`, or null. */
const ignoredBy = (globs: readonly string[], path: string): string | null => globs.find((g) => globMatches(g, path)) ?? null;

// ── what a service loads ──────────────────────────────────────────────────────

interface Closure {
  /** Every source file the start script imports, itself included, relative to the repository root. */
  files: string[];
  /** Bare imports esbuild left outside the bundle (node builtins and installed packages). */
  externals: string[];
}

async function importClosure(entry: string): Promise<Closure> {
  const result = await build({
    entryPoints: [relative(API_DIR, join(REPO_ROOT, entry))],
    absWorkingDir: API_DIR,
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    format: "esm",
    packages: "external",
    logLevel: "silent",
  });
  const inputs = result.metafile.inputs;
  const files = Object.keys(inputs).map((f) => relative(REPO_ROOT, resolve(API_DIR, f)).split(sep).join("/"));
  const externals = new Set<string>();
  for (const input of Object.values(inputs)) for (const imp of input.imports) if (imp.external) externals.add(imp.path);
  return { files: files.sort(), externals: [...externals].sort() };
}

/**
 * Files a script reads from beside its own source at run time. The import graph cannot see
 * these, so they are listed by hand, keyed by the script that reads them. The demo service
 * serves its recording from scripts/assets (MEDIA_DIR), and the shadow worker imports it.
 */
const READ_AT_RUNTIME: Readonly<Record<string, readonly string[]>> = {
  "services/api/scripts/eventProtectXDemoService.ts": Object.keys(MEDIA_FILES).map((name) => `services/api/scripts/assets/${name}`),
};

/** How a script finds files beside itself. A file using any of these must be in READ_AT_RUNTIME. */
const LOCATES_ITSELF = /import\.meta\.(url|dirname|filename)|\b__dirname\b|\b__filename\b/;

/** Read by `npm ci` or by tsx on every start, for every service. */
const ALWAYS_LOADED = ["package.json", "package-lock.json", "tsconfig.base.json", "services/api/package.json", "services/api/tsconfig.json"];

const SERVICES = parseBlueprint(readFileSync(join(REPO_ROOT, BLUEPRINT), "utf8"));
const closures = new Map<string, Promise<Closure>>();
const closureOf = (svc: BlueprintService): Promise<Closure> => {
  let c = closures.get(svc.entry);
  if (!c) {
    c = importClosure(svc.entry);
    closures.set(svc.entry, c);
  }
  return c;
};

// ── the matcher and the parser themselves ─────────────────────────────────────

test("eventDeployFilters glob: ** is any depth including none, * stays inside one segment, the rest is literal", () => {
  assert.ok(globMatches("docs/**", "docs/a.md"));
  assert.ok(globMatches("docs/**", "docs/reports/2026/x.txt"));
  assert.ok(!globMatches("docs/**", "services/docs/a.md"));
  assert.ok(!globMatches("docs/**", "docsx/a.md"));

  assert.ok(globMatches("**/*.md", "README.md"), "** matches no directory at all");
  assert.ok(globMatches("**/*.md", "services/api/scripts/assets/README.md"));
  assert.ok(!globMatches("**/*.md", "notes.mdx"));
  assert.ok(!globMatches("**/*.md", "services/api/src/readme.md/index.ts"));

  assert.ok(globMatches("services/api/scripts/btc*.ts", "services/api/scripts/btcPairsService.ts"));
  assert.ok(!globMatches("services/api/scripts/btc*.ts", "services/api/scripts/btc/x.ts"), "* does not cross a slash");
  assert.ok(!globMatches("services/api/scripts/btc*.ts", "services/api/scripts/sportsBtc.ts"));
  assert.ok(!globMatches("services/api/scripts/btc*.ts", "services/api/src/btcCurve/pairs.ts"));

  assert.ok(globMatches("services/api/src/**", "services/api/src/eventCollar/crossVenue/types.ts"));
  assert.ok(globMatches("a/**/b.ts", "a/b.ts"));
  assert.ok(globMatches("a/**/b.ts", "a/x/y/b.ts"));
  assert.ok(!globMatches("a/**/b.ts", "a/x/c.ts"));

  assert.ok(globMatches(".github/**", ".github/workflows/ci.yml"));
  assert.ok(!globMatches(".github/**", "xgithub/workflows/ci.yml"), "a dot is a dot");

  for (const bad of ["src/[ab].ts", "src/?.ts", "src/**.ts", "/docs/**", "docs//x", ""]) {
    assert.throws(() => globToRegExp(bad), /unsupported glob/, `refuses ${JSON.stringify(bad)}`);
  }
});

test("eventDeployFilters parser: reads name, start script and ignored paths; refuses what it cannot read", () => {
  const ok = [
    "# header",
    "services:",
    "  - type: web",
    "    name: one",
    "    startCommand: npm --workspace services/api exec tsx scripts/one.ts",
    "    # a comment between the keys",
    "    buildFilter:",
    "      ignoredPaths:",
    "        - docs/**",
    '        - "**/*.md"   # quoted because a plain * starts an alias',
    "    envVars:",
    "      - key: NAME",
    "        value: not-a-service-name",
    "  - type: web",
    "    name: two",
    "    startCommand: npm --workspace services/api exec tsx scripts/two.ts",
    "    buildFilter:",
    "      ignoredPaths:",
    "        - services/api/tests/**",
  ].join("\n");
  assert.deepEqual(parseBlueprint(ok), [
    { name: "one", startCommand: "npm --workspace services/api exec tsx scripts/one.ts", entry: "services/api/scripts/one.ts", ignoredPaths: ["docs/**", "**/*.md"] },
    { name: "two", startCommand: "npm --workspace services/api exec tsx scripts/two.ts", entry: "services/api/scripts/two.ts", ignoredPaths: ["services/api/tests/**"] },
  ]);

  const service = (lines: string[]): string => ["services:", "  - type: web", ...lines].join("\n");
  const start = "    startCommand: npm --workspace services/api exec tsx scripts/one.ts";
  const filter = ["    buildFilter:", "      ignoredPaths:", "        - docs/**"];
  assert.throws(() => parseBlueprint("databases:\n  - name: x\n"), /no services found/);
  assert.throws(() => parseBlueprint(service([start, ...filter])), /no name/);
  assert.throws(() => parseBlueprint(service(["    name: one", ...filter])), /no startCommand/);
  assert.throws(() => parseBlueprint(service(["    name: one", "    startCommand: node dist/server.js", ...filter])), /not "tsx <script>\.ts"/);
  assert.throws(() => parseBlueprint(service(["    name: one", start])), /no buildFilter\.ignoredPaths/);
  assert.throws(() => parseBlueprint(service(["    name: one", start, "    buildFilter:", "      ignoredPaths: [docs/**]"])), /block list/);
  assert.throws(() => parseBlueprint(service(["    name: one", start, "    buildFilter:", "      ignoredPaths:", "        - **/*.md"])), /cannot read the value/);
  assert.throws(
    () => parseBlueprint(service(["    name: one", start, "    buildFilter:", "      paths:", "        - services/api/**", "      ignoredPaths:", "        - docs/**"])),
    /may only carry ignoredPaths, found "paths"/,
    "an include list would leave every new file out of the deploy",
  );
});

// ── the blueprint itself ──────────────────────────────────────────────────────

test("eventDeployFilters blueprint: every service is read, each start script exists, each ignored path points into a folder that exists", () => {
  const text = readFileSync(join(REPO_ROOT, BLUEPRINT), "utf8");
  const declared = text.split("\n").filter((l) => /^ {2}- type:/.test(l)).length;
  assert.ok(declared > 0, "the blueprint declares services");
  assert.equal(SERVICES.length, declared, "the parser saw every service the file declares");
  assert.equal(new Set(SERVICES.map((s) => s.name)).size, SERVICES.length, "service names are unique");
  for (const svc of SERVICES) {
    assert.ok(existsSync(join(REPO_ROOT, svc.entry)), `${svc.name}: start script ${svc.entry} exists`);
    for (const glob of svc.ignoredPaths) {
      assert.doesNotThrow(() => globToRegExp(glob), `${svc.name}: ${glob}`);
      // A folder that was renamed or removed leaves a line here that ignores nothing.
      const segments = glob.split("/");
      const firstWild = segments.findIndex((seg) => seg.includes("*"));
      const folder = segments.slice(0, firstWild < 0 ? segments.length - 1 : firstWild).join("/");
      assert.ok(existsSync(join(REPO_ROOT, folder)), `${svc.name}: ${glob} points into ${folder || "the repository root"}, which exists`);
    }
    assert.equal(new Set(svc.ignoredPaths).size, svc.ignoredPaths.length, `${svc.name}: no ignored path is listed twice`);
  }
});

test("eventDeployFilters common: every service ignores the docs and the tests", () => {
  for (const svc of SERVICES) {
    for (const glob of ["docs/**", "services/api/tests/**"]) {
      assert.ok(svc.ignoredPaths.includes(glob), `${svc.name}: ${glob} is ignored`);
    }
  }
});

test("eventDeployFilters entry: a service never ignores its own start script, the blueprint or what the install and tsx read", () => {
  for (const svc of SERVICES) {
    for (const path of [svc.entry, BLUEPRINT, ...ALWAYS_LOADED]) {
      assert.ok(existsSync(join(REPO_ROOT, path)), `${path} exists`);
      assert.equal(ignoredBy(svc.ignoredPaths, path), null, `${svc.name}: ${path} must trigger a deploy`);
    }
  }
});

test("eventDeployFilters closure: no file a start script imports is on its service's ignored paths", async () => {
  for (const svc of SERVICES) {
    const { files } = await closureOf(svc);
    assert.ok(files.includes(svc.entry), `${svc.name}: the closure starts at ${svc.entry}`);
    const stale = files.flatMap((f) => {
      const glob = ignoredBy(svc.ignoredPaths, f);
      return glob ? [`${f} (ignored by ${glob})`] : [];
    });
    assert.deepEqual(stale, [], `${svc.name} imports files its build filter ignores, so a change to them would not redeploy it`);
  }
});

test("eventDeployFilters closure: nothing is imported from this repository's own workspace packages", async () => {
  // The closure is built with installed packages left outside it, and the @foxify packages are
  // installed as links into this repository (services/connectors, services/hedging, packages/shared).
  // An import of one would be a source dependency the check above cannot see.
  for (const svc of SERVICES) {
    const { externals } = await closureOf(svc);
    assert.deepEqual(
      externals.filter((p) => p.startsWith("@foxify/")),
      [],
      `${svc.name}: teach this test to follow workspace packages before a start script imports one`,
    );
  }
});

test("eventDeployFilters runtime files: what a script reads from beside its source is listed here and never ignored", async () => {
  for (const svc of SERVICES) {
    const { files } = await closureOf(svc);
    for (const file of files) {
      if (!LOCATES_ITSELF.test(readFileSync(join(REPO_ROOT, file), "utf8"))) continue;
      const reads = READ_AT_RUNTIME[file];
      assert.ok(reads, `${file} locates files beside its own source (import.meta.url or __dirname): list what it reads in READ_AT_RUNTIME so the filters are checked against it`);
      assert.ok(reads.length > 0, `${file}: READ_AT_RUNTIME lists at least one file`);
      for (const path of reads) {
        assert.ok(existsSync(join(REPO_ROOT, path)), `${path} exists`);
        assert.equal(ignoredBy(svc.ignoredPaths, path), null, `${svc.name}: ${path} is read at run time by ${file} and must trigger a deploy`);
      }
    }
  }
});
