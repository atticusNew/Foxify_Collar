/**
 * Shadow bot smoke test — verifies bot makes correct selection decisions
 * given various regime/halt scenarios. Uses a mock HTTP server to avoid
 * touching the live Render endpoint.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

type MockState = {
  regime: string;
  dvol: number | null;
  haltAtticus: boolean;
  haltReason: string | null;
  activateCalls: Array<{ cellId: string; foxifyPairRef: string; isShadow: boolean }>;
  activateBehavior: "ok" | "reject-cell-disabled" | "reject-price-exceeded";
};

let server: Server;
let serverPort = 0;
let state: MockState;

const resetState = (): void => {
  state = {
    regime: "moderate",
    dvol: 45,
    haltAtticus: false,
    haltReason: null,
    activateCalls: [],
    activateBehavior: "ok"
  };
};

beforeAll(async () => {
  resetState();
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/foxify/v2/regime") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            regime: state.regime,
            dvol: state.dvol,
            sigma_annual: 0.6,
            as_of_ms: Date.now(),
            halt: { foxify: false, atticus: state.haltAtticus, reason: state.haltReason }
          }));
          return;
        }
        if (req.url === "/foxify/v2/activate" && req.method === "POST") {
          const parsed = JSON.parse(body);
          state.activateCalls.push({ cellId: parsed.cellId, foxifyPairRef: parsed.foxifyPairRef, isShadow: parsed.isShadow });
          if (state.activateBehavior === "reject-cell-disabled") {
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "cell_disabled_in_regime", message: "cell not allowed in current regime" }));
            return;
          }
          if (state.activateBehavior === "reject-price-exceeded") {
            res.writeHead(422, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "price_exceeded", message: "hedge cost above max" }));
            return;
          }
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ pair_id: `pair_${Date.now()}`, status: "active", foxify_pair_ref: parsed.foxifyPairRef }));
          return;
        }
        res.writeHead(404);
        res.end("not found");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") serverPort = addr.port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const runBotForOneTick = async (waitMs = 5_000): Promise<{ stdout: string; stderr: string }> => {
  const scriptPath = path.resolve(__dirname, "../scripts/integration/foxifyShadowBot.ts");
  return new Promise((resolve) => {
    const child: ChildProcess = spawn("npx", ["tsx", scriptPath], {
      env: {
        ...process.env,
        FOXIFY_API_URL: `http://127.0.0.1:${serverPort}`,
        FOXIFY_API_KEY: "test-token",
        SHADOW_BOT_PAIRS_PER_DAY: "100000", // ensures only initial tick fires within window
        SHADOW_BOT_STOP_AFTER_HOURS: "0"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      try { child.kill("SIGKILL"); } catch { /* already dead */ }
      resolve({ stdout, stderr });
    };
    child.stdout?.on("data", (d) => {
      stdout += d.toString();
      // Resolve once we see definitive evidence the first tick completed:
      // either an ACTIVATE OK / activate rejected / activate skipped log.
      if (/(ACTIVATE OK|activate rejected|activate skipped)/.test(stdout)) {
        // Give a small grace period for any followup tick logic, then exit
        setTimeout(finish, 250);
      }
    });
    child.stderr?.on("data", (d) => { stderr += d.toString(); });
    setTimeout(finish, waitMs);
  });
};

describe("foxifyShadowBot", () => {
  it("sends shadow activate in moderate regime with first preferred cell", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "moderate";
    state.activateBehavior = "ok";

    await runBotForOneTick();

    expect(state.activateCalls.length).toBeGreaterThanOrEqual(1);
    const call = state.activateCalls[0];
    expect(call.cellId).toBe("pair_25k_5pct_otm_short");
    expect(call.isShadow).toBe(true);
    expect(call.foxifyPairRef).toMatch(/^shadow-bot-/);
  });

  it("falls through to second preferred cell when first rejected", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "moderate";
    state.activateBehavior = "reject-cell-disabled";

    await runBotForOneTick();

    expect(state.activateCalls.length).toBe(2);
    expect(state.activateCalls[0].cellId).toBe("pair_25k_5pct_otm_short");
    expect(state.activateCalls[1].cellId).toBe("pair_50k_4pct_otm_short");
  });

  it("skips activation when atticus halt active", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "moderate";
    state.haltAtticus = true;
    state.haltReason = "dvol_calm";

    const r = await runBotForOneTick();

    expect(state.activateCalls.length).toBe(0);
    expect(r.stdout).toMatch(/activate skipped — halt active/);
  });

  it("uses elevated regime cells when regime is elevated", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "elevated";

    await runBotForOneTick();

    expect(state.activateCalls.length).toBeGreaterThanOrEqual(1);
    // elevated prefers pair_50k_5pct_otm first
    expect(state.activateCalls[0].cellId).toBe("pair_50k_5pct_otm");
  });
});
