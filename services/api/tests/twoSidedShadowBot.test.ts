/**
 * Shadow bot smoke test — verifies bot makes correct selection decisions
 * given various regime/halt scenarios. Uses a mock HTTP server to avoid
 * touching the live Render endpoint.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

type MockState = {
  regime: string;
  goodToActivate: boolean;
  reason: string | null;
  recommendedCells: string[];
  calmLossLeader: { enabled: boolean; max_loss_usdc?: number; eligible_cells?: string[] };
  activateCalls: Array<{ cellId: string; foxifyPairRef: string; isShadow: boolean; maxCost: number; mode: string | undefined }>;
  activateBehavior: "ok" | "reject-cell-disabled" | "reject-price-exceeded";
};

let server: Server;
let serverPort = 0;
let state: MockState;

const resetState = (): void => {
  state = {
    regime: "moderate",
    goodToActivate: true,
    reason: null,
    recommendedCells: ["pair_50k_3pct_atm_3d", "pair_25k_5pct_otm_3d"],
    calmLossLeader: { enabled: false },
    activateCalls: [],
    activateBehavior: "ok"
  };
};

before(async () => {
  resetState();
  await new Promise<void>((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        if (req.url === "/foxify/v2/should_activate") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            good_to_activate: state.goodToActivate,
            reason: state.reason,
            regime: state.regime,
            signal_tier: state.goodToActivate ? "positive" : "stand_down",
            recommended_cells: state.recommendedCells,
            recommended_structure: "straddle",
            calm_loss_leader: state.calmLossLeader
          }));
          return;
        }
        if (req.url === "/foxify/v2/activate" && req.method === "POST") {
          const parsed = JSON.parse(body);
          state.activateCalls.push({
            cellId: parsed.cellId, foxifyPairRef: parsed.foxifyPairRef, isShadow: parsed.isShadow,
            maxCost: parsed.maxAcceptableHedgeCostUsdc, mode: parsed.metadata?.mode
          });
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

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const runBotForOneTick = async (waitMs = 5_000): Promise<{ stdout: string; stderr: string }> => {
  const scriptPath = fileURLToPath(new URL("../scripts/integration/foxifyShadowBot.ts", import.meta.url));
  return new Promise((resolve) => {
    // detached:true → the child is its own process-group leader, so we can kill the
    // WHOLE tree (npx → node → tsx → bot) via the negative PID. Without this, SIGKILL
    // on the `npx` wrapper leaves the bot grandchild alive, holding the stdio pipes
    // open and HANGING the test runner after the assertions pass.
    const child: ChildProcess = spawn("npx", ["tsx", scriptPath], {
      detached: true,
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
      // Kill the entire detached process group (negative PID) so no grandchild
      // (the bot) survives to keep the event loop / pipes alive.
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already dead */ }
      }
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
  it("fires the first recommended_cell when good_to_activate (signal mode, shadow)", { timeout: 30_000 }, async () => {
    resetState();
    state.goodToActivate = true;
    state.recommendedCells = ["pair_50k_3pct_atm_3d", "pair_25k_5pct_otm_3d"];

    await runBotForOneTick();

    assert.ok(state.activateCalls.length >= 1, `expected >=1 activate call, got ${state.activateCalls.length}`);
    const call = state.activateCalls[0];
    assert.equal(call.cellId, "pair_50k_3pct_atm_3d", "fires the top recommended cell");
    assert.equal(call.isShadow, true, "shadow by default (no SHADOW_BOT_LIVE)");
    assert.equal(call.mode, "signal");
    assert.match(call.foxifyPairRef, /^foxify-bot-/);
  });

  it("falls through to the second recommended_cell when the first is rejected", { timeout: 30_000 }, async () => {
    resetState();
    state.goodToActivate = true;
    state.recommendedCells = ["pair_50k_3pct_atm_3d", "pair_25k_5pct_otm_3d"];
    state.activateBehavior = "reject-cell-disabled";

    await runBotForOneTick();

    assert.equal(state.activateCalls.length, 2);
    assert.equal(state.activateCalls[0].cellId, "pair_50k_3pct_atm_3d");
    assert.equal(state.activateCalls[1].cellId, "pair_25k_5pct_otm_3d");
  });

  it("skips activation when the signal reports a halt", { timeout: 30_000 }, async () => {
    resetState();
    state.goodToActivate = false;
    state.reason = "halt_active:atticus:dvol_high";

    const r = await runBotForOneTick();

    assert.equal(state.activateCalls.length, 0);
    assert.match(r.stdout, /activate skipped — halt active/);
  });

  it("fires a budgeted loss-leader cell in calm when offered (loss_leader mode, capped cost)", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "calm";
    state.goodToActivate = false; // calm is never a +EV GO
    state.recommendedCells = [];
    state.calmLossLeader = { enabled: true, max_loss_usdc: 55, eligible_cells: ["pair_25k_5otm_strangle_2d", "pair_25k_5otm_strangle_1d"] };

    await runBotForOneTick();

    assert.ok(state.activateCalls.length >= 1, `expected a loss-leader fire, got ${state.activateCalls.length}`);
    const call = state.activateCalls[0];
    assert.equal(call.cellId, "pair_25k_5otm_strangle_2d", "fires the first eligible loss-leader cell");
    assert.equal(call.mode, "loss_leader");
    assert.equal(call.maxCost, 55, "caps the bid at the loss-leader budget");
    assert.equal(call.isShadow, true);
  });

  it("stands down when not good and no loss-leader offered", { timeout: 30_000 }, async () => {
    resetState();
    state.regime = "calm";
    state.goodToActivate = false;
    state.recommendedCells = [];
    state.calmLossLeader = { enabled: false };

    const r = await runBotForOneTick();

    assert.equal(state.activateCalls.length, 0);
    assert.match(r.stdout, /activate skipped — stand down/);
  });
});
