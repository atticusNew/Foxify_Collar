import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const randomPort = (): number => 20000 + Math.floor(Math.random() * 20000);

const startBridge = (port: number, extraEnv?: Record<string, string>) => {
  const child = spawn("npm", ["--workspace", "services/broker-bridge", "run", "start"], {
    cwd: "/workspace",
    env: {
      ...process.env,
      IBKR_BRIDGE_PORT: String(port),
      IBKR_BRIDGE_HOST: "127.0.0.1",
      IBKR_BRIDGE_TOKEN: "",
      ...extraEnv
    },
    stdio: "ignore"
  });
  return child;
};

test("broker-bridge health endpoint returns ok payload", async () => {
  const port = randomPort();
  const child = startBridge(port);

  try {
    await wait(1200);
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.ok, true);
    const payload = (await res.json()) as {
      ok?: boolean;
      session?: string;
      transport?: string;
      activeTransport?: string;
      fallbackEnabled?: boolean;
      asOf?: string;
    };
    assert.equal(payload.ok, true);
    assert.equal(payload.transport, "synthetic");
    assert.equal(payload.activeTransport, "synthetic");
    assert.equal(payload.fallbackEnabled, true);
    assert.ok(payload.session === "connected" || payload.session === "disconnected");
    assert.equal(typeof payload.asOf, "string");
  } finally {
    child.kill("SIGTERM");
    await wait(150);
  }
});

test("ib_socket transport falls back when gateway unavailable", async () => {
  const port = randomPort();
  const child = startBridge(port, {
    IBKR_BRIDGE_TRANSPORT: "ib_socket",
    IBKR_BRIDGE_FALLBACK_TO_SYNTHETIC: "true",
    IBKR_GATEWAY_HOST: "127.0.0.1",
    IBKR_GATEWAY_PORT: "65530",
    IBKR_GATEWAY_CONNECT_TIMEOUT_MS: "700",
    IBKR_GATEWAY_REQUEST_TIMEOUT_MS: "700"
  });

  try {
    await wait(1400);
    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(healthRes.ok, true);
    const health = (await healthRes.json()) as {
      transport?: string;
      activeTransport?: string;
      fallbackEnabled?: boolean;
      lastFallbackReason?: string;
    };
    assert.equal(health.transport, "ib_socket");
    assert.equal(health.fallbackEnabled, true);
    assert.equal(health.activeTransport, "synthetic_fallback");
    assert.equal(typeof health.lastFallbackReason, "string");

    const topRes = await fetch(`http://127.0.0.1:${port}/marketdata/top`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conId: 12345 })
    });
    assert.equal(topRes.ok, true);
    const top = (await topRes.json()) as { bid?: number; ask?: number };
    assert.equal(typeof top.bid, "number");
    assert.equal(typeof top.ask, "number");
  } finally {
    child.kill("SIGTERM");
    await wait(150);
  }
});
