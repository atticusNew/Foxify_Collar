import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test("broker-bridge health endpoint returns ok payload", async () => {
  const port = 18181;
  const child = spawn(
    "npm",
    ["--workspace", "services/broker-bridge", "run", "start"],
    {
      cwd: "/workspace",
      env: {
        ...process.env,
        IBKR_BRIDGE_PORT: String(port),
        IBKR_BRIDGE_HOST: "127.0.0.1",
        IBKR_BRIDGE_TOKEN: ""
      },
      stdio: "ignore"
    }
  );

  try {
    await wait(1200);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.ok, true);
    const payload = (await res.json()) as { ok?: boolean; session?: string; asOf?: string };
    assert.equal(payload.ok, true);
    assert.ok(payload.session === "connected" || payload.session === "disconnected");
    assert.equal(typeof payload.asOf, "string");
  } finally {
    child.kill("SIGTERM");
  }
});
