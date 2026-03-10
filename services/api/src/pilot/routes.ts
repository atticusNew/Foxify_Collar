import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import Decimal from "decimal.js";
import { randomUUID } from "node:crypto";
import { DeribitConnector } from "@foxify/connectors";
import { buildUserHash } from "./hash";
import { pilotConfig } from "./config";
import {
  ensurePilotSchema,
  getPilotPool,
  getProtection,
  getProofPayload,
  insertAdminAction,
  insertLedgerEntry,
  insertPriceSnapshot,
  insertProtection,
  insertVenueExecution,
  insertVenueQuote,
  listLedgerForProtection,
  listProtections,
  patchProtection
} from "./db";
import { resolvePriceSnapshot } from "./price";
import { createPilotVenueAdapter, mapVenueFailureReason } from "./venue";

const getRequestIp = (req: FastifyRequest): string => {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip;
};

const parseBoolean = (value: unknown, fallback = false): boolean => {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
};

const requireAdmin = async (
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ actor: string; actorIp: string } | null> => {
  const token = String(req.headers["x-admin-token"] || "");
  const actor = String(req.headers["x-admin-actor"] || "pilot-ops");
  const actorIp = getRequestIp(req);
  if (!pilotConfig.adminToken || token !== pilotConfig.adminToken) {
    reply.code(401).send({ status: "error", reason: "unauthorized_admin" });
    return null;
  }
  if (
    pilotConfig.adminIpAllowlist.entries.length > 0 &&
    !pilotConfig.adminIpAllowlist.entries.includes(actorIp)
  ) {
    reply.code(403).send({ status: "error", reason: "admin_ip_not_allowlisted" });
    return null;
  }
  return { actor, actorIp };
};

const toCsv = (rows: Array<Record<string, unknown>>): string => {
  if (!rows.length) return "";
  const columns = Object.keys(rows[0]);
  const escape = (value: unknown): string => {
    const str = value === null || value === undefined ? "" : String(value);
    if (str.includes(",") || str.includes("\"") || str.includes("\n")) {
      return `"${str.replace(/"/g, "\"\"")}"`;
    }
    return str;
  };
  const header = columns.join(",");
  const body = rows.map((row) => columns.map((col) => escape(row[col])).join(",")).join("\n");
  return `${header}\n${body}`;
};

export const registerPilotRoutes = async (
  app: FastifyInstance,
  deps: { deribit: DeribitConnector }
): Promise<void> => {
  if (!pilotConfig.enabled) return;
  const pool = getPilotPool(pilotConfig.postgresUrl);
  await ensurePilotSchema(pool);
  const venue = createPilotVenueAdapter({
    mode: pilotConfig.venueMode,
    falconx: {
      baseUrl: pilotConfig.falconxBaseUrl,
      apiKey: pilotConfig.falconxApiKey,
      secret: pilotConfig.falconxSecret,
      passphrase: pilotConfig.falconxPassphrase
    },
    deribit: deps.deribit
  });

  const resolveAndPersistExpiry = async (protectionId: string): Promise<void> => {
    const protection = await getProtection(pool, protectionId);
    if (!protection) return;
    if (!["active", "awaiting_expiry_price"].includes(protection.status)) return;
    const expiryAt = new Date(protection.expiryAt);
    if (Date.now() < expiryAt.getTime()) return;
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.dydxPriceUrl,
          fallbackUrl: pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs
        },
        {
          marketId: protection.marketId,
          now: new Date(),
          expiryAt,
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      await insertPriceSnapshot(pool, {
        protectionId,
        snapshotType: "expiry",
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        priceSource: snapshot.priceSource,
        priceSourceDetail: snapshot.priceSourceDetail,
        endpointVersion: snapshot.endpointVersion,
        requestId: snapshot.requestId,
        priceTimestamp: snapshot.priceTimestamp
      });
      const entryPrice = new Decimal(protection.entryPrice || "0");
      const protectedNotional = new Decimal(protection.protectedNotional);
      const expiryPrice = snapshot.price;
      let payoutDue = new Decimal(0);
      if (entryPrice.gt(0) && expiryPrice.lt(entryPrice)) {
        payoutDue = entryPrice
          .minus(expiryPrice)
          .div(entryPrice)
          .mul(protectedNotional);
      }
      const nextStatus = payoutDue.gt(0) ? "expired_itm" : "expired_otm";
      await patchProtection(pool, protectionId, {
        status: nextStatus,
        expiry_price: snapshot.price.toFixed(10),
        expiry_price_source: snapshot.priceSource,
        expiry_price_timestamp: snapshot.priceTimestamp,
        payout_due_amount: payoutDue.toFixed(10)
      });
      if (payoutDue.gt(0)) {
        await insertLedgerEntry(pool, {
          protectionId,
          entryType: "payout_due",
          amount: payoutDue.toFixed(10),
          reference: `expiry:${snapshot.priceTimestamp}`
        });
      }
    } catch (error: any) {
      await patchProtection(pool, protectionId, {
        status: "awaiting_expiry_price",
        metadata: {
          ...protection.metadata,
          expiryError: String(error?.message || "expiry_price_unavailable")
        }
      });
    }
  };

  app.post("/pilot/protections/quote", async (req, reply) => {
    const body = req.body as {
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      instrumentId?: string;
      marketId?: string;
      clientOrderId?: string;
    };
    const protectedNotional = Number(body.protectedNotional || 0);
    const exposureNotional = Number(body.foxifyExposureNotional || 0);
    if (!Number.isFinite(protectedNotional) || protectedNotional <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!Number.isFinite(exposureNotional) || exposureNotional <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    if (protectedNotional > exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    const marketId = body.marketId || pilotConfig.dydxBtcMarketId;
    const requestId = pilotConfig.nextRequestId();
    try {
      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.dydxPriceUrl,
          fallbackUrl: pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      const quantity = new Decimal(protectedNotional).div(snapshot.price).toDecimalPlaces(8).toNumber();
      const quote = await venue.quote({
        marketId,
        protectedNotional,
        quantity,
        side: "buy",
        instrumentId: body.instrumentId || `${marketId}-7D-P`,
        clientOrderId: body.clientOrderId
      });
      await insertVenueQuote(pool, quote);
      return {
        status: "ok",
        quote,
        entrySnapshot: {
          price: snapshot.price.toFixed(10),
          marketId: snapshot.marketId,
          source: snapshot.priceSource,
          timestamp: snapshot.priceTimestamp,
          requestId: snapshot.requestId
        }
      };
    } catch (error: any) {
      reply.code(503);
      return {
        status: "error",
        reason: "price_unavailable",
        message: "Price temporarily unavailable, please retry.",
        detail: String(error?.message || "price_chain_error")
      };
    }
  });

  app.post("/pilot/protections/activate", async (req, reply) => {
    const body = req.body as {
      userId?: string;
      protectedNotional?: number;
      foxifyExposureNotional?: number;
      instrumentId?: string;
      marketId?: string;
      expiryAt?: string;
      tenorDays?: number;
      autoRenew?: boolean;
      renewWindowMinutes?: number;
      clientOrderId?: string;
    };
    if (!body.userId) {
      reply.code(400);
      return { status: "error", reason: "missing_user_id" };
    }
    const protectedNotional = Number(body.protectedNotional || 0);
    const exposureNotional = Number(body.foxifyExposureNotional || 0);
    if (!Number.isFinite(protectedNotional) || protectedNotional <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_protected_notional" };
    }
    if (!Number.isFinite(exposureNotional) || exposureNotional <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_exposure_notional" };
    }
    if (protectedNotional > exposureNotional) {
      reply.code(400);
      return { status: "error", reason: "protected_notional_exceeds_exposure" };
    }
    const userHash = buildUserHash({
      rawUserId: body.userId,
      secret: pilotConfig.hashSecret,
      hashVersion: pilotConfig.hashVersion
    });
    const marketId = body.marketId || pilotConfig.dydxBtcMarketId;
    const tenorDays = Math.max(1, Number(body.tenorDays || 7));
    const expiryAt = body.expiryAt || new Date(Date.now() + tenorDays * 86400000).toISOString();
    const requestId = pilotConfig.nextRequestId();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const protection = await insertProtection(client, {
        userHash: userHash.userHash,
        hashVersion: userHash.hashVersion,
        status: "pending_activation",
        marketId,
        protectedNotional: protectedNotional.toString(),
        foxifyExposureNotional: exposureNotional.toString(),
        expiryAt,
        autoRenew: parseBoolean(body.autoRenew, false),
        renewWindowMinutes: Number(body.renewWindowMinutes || 1440),
        metadata: {
          mode: "pilot",
          venueMode: pilotConfig.venueMode
        }
      });
      const snapshot = await resolvePriceSnapshot(
        {
          primaryUrl: pilotConfig.dydxPriceUrl,
          fallbackUrl: pilotConfig.fallbackPriceUrl,
          primaryTimeoutMs: pilotConfig.pricePrimaryTimeoutMs,
          fallbackTimeoutMs: pilotConfig.priceFallbackTimeoutMs,
          freshnessMaxMs: pilotConfig.priceFreshnessMaxMs
        },
        {
          marketId,
          now: new Date(),
          requestId,
          endpointVersion: pilotConfig.endpointVersion
        }
      );
      await insertPriceSnapshot(client, {
        protectionId: protection.id,
        snapshotType: "entry",
        price: snapshot.price.toFixed(10),
        marketId: snapshot.marketId,
        priceSource: snapshot.priceSource,
        priceSourceDetail: snapshot.priceSourceDetail,
        endpointVersion: snapshot.endpointVersion,
        requestId: snapshot.requestId,
        priceTimestamp: snapshot.priceTimestamp
      });
      const quantity = new Decimal(protectedNotional).div(snapshot.price).toDecimalPlaces(8).toNumber();
      const instrumentId = body.instrumentId || `${marketId}-7D-P`;
      const quote = await venue.quote({
        marketId,
        instrumentId,
        protectedNotional,
        quantity,
        side: "buy",
        clientOrderId: body.clientOrderId
      });
      await insertVenueQuote(client, { ...quote, protectionId: protection.id });
      const execution = await venue.execute(quote);
      if (execution.status !== "success") {
        throw new Error("execution_failed");
      }
      const coverageRatio =
        quantity > 0 ? new Decimal(execution.quantity).div(new Decimal(quantity)) : new Decimal(0);
      const threshold = new Decimal(1).minus(new Decimal(pilotConfig.fullCoverageTolerancePct));
      if (
        (pilotConfig.requireFullCoverage || pilotConfig.requireFullExecutionFill) &&
        coverageRatio.lt(threshold)
      ) {
        throw new Error("full_coverage_not_met");
      }
      await insertVenueExecution(client, protection.id, execution);
      await insertLedgerEntry(client, {
        protectionId: protection.id,
        entryType: "premium_due",
        amount: new Decimal(execution.premium).toFixed(10),
        reference: execution.externalOrderId
      });
      const updated = await patchProtection(client, protection.id, {
        status: "active",
        entry_price: snapshot.price.toFixed(10),
        entry_price_source: snapshot.priceSource,
        entry_price_timestamp: snapshot.priceTimestamp,
        venue: execution.venue,
        instrument_id: execution.instrumentId,
        side: execution.side,
        size: new Decimal(execution.quantity).toFixed(10),
        execution_price: new Decimal(execution.executionPrice).toFixed(10),
        premium: new Decimal(execution.premium).toFixed(10),
        executed_at: execution.executedAt,
        external_order_id: execution.externalOrderId,
        external_execution_id: execution.externalExecutionId,
        metadata: {
          ...(protection.metadata || {}),
          quoteId: quote.quoteId,
          rfqId: quote.rfqId || null,
          coverageRatio: coverageRatio.toFixed(6)
        }
      });
      await client.query("COMMIT");
      return {
        status: "ok",
        protection: updated,
        coverageRatio: coverageRatio.toFixed(6),
        quote
      };
    } catch (error: any) {
      await client.query("ROLLBACK");
      const errMsg = String(error?.message || "");
      const reason = errMsg.includes("price_unavailable")
        ? "price_unavailable"
        : mapVenueFailureReason(error);
      reply.code(reason === "price_unavailable" ? 503 : 400);
      return {
        status: "error",
        reason,
        message:
          reason === "price_unavailable"
            ? "Price temporarily unavailable, please retry."
            : "Protection activation failed."
      };
    } finally {
      client.release();
    }
  });

  app.get("/pilot/protections/:id", async (req, reply) => {
    const params = req.params as { id: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection };
  });

  app.get("/pilot/protections/:id/proof", async (req, reply) => {
    const params = req.params as { id: string };
    const payload = await getProofPayload(pool, params.id);
    if (!payload) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", ...payload };
  });

  app.get("/pilot/protections/export", async (req, reply) => {
    const query = req.query as { format?: string; limit?: string };
    const protections = await listProtections(pool, { limit: Number(query.limit || 200) });
    const rows = protections.map((item) => ({
      protection_id: item.id,
      status: item.status,
      created_at: item.createdAt,
      expiry_at: item.expiryAt,
      market_id: item.marketId,
      entry_price: item.entryPrice,
      expiry_price: item.expiryPrice,
      protected_notional: item.protectedNotional,
      premium: item.premium,
      payout_due_amount: item.payoutDueAmount,
      payout_settled_amount: item.payoutSettledAmount,
      venue: item.venue,
      instrument_id: item.instrumentId,
      external_order_id: item.externalOrderId,
      external_execution_id: item.externalExecutionId
    }));
    if (String(query.format || "json").toLowerCase() === "csv") {
      reply.header("Content-Type", "text/csv");
      return toCsv(rows);
    }
    return { status: "ok", rows };
  });

  app.post("/pilot/protections/:id/renewal-decision", async (req, reply) => {
    const params = req.params as { id: string };
    const body = req.body as { decision?: "renew" | "expire" };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (body.decision === "expire") {
      const updated = await patchProtection(pool, params.id, { status: "cancelled" });
      return { status: "ok", protection: updated };
    }
    if (body.decision === "renew") {
      const now = new Date();
      const previousExpiry = new Date(protection.expiryAt).getTime();
      const nextExpiry = Number.isFinite(previousExpiry)
        ? new Date(previousExpiry + 7 * 86400000)
        : new Date(now.getTime() + 7 * 86400000);
      const cloned = await insertProtection(pool, {
        userHash: protection.userHash,
        hashVersion: protection.hashVersion,
        status: "awaiting_renew_decision",
        marketId: protection.marketId,
        protectedNotional: protection.protectedNotional,
        foxifyExposureNotional: protection.foxifyExposureNotional,
        expiryAt: nextExpiry.toISOString(),
        autoRenew: protection.autoRenew,
        renewWindowMinutes: protection.renewWindowMinutes,
        metadata: { renewalOf: protection.id }
      });
      return { status: "ok", protection: cloned };
    }
    reply.code(400);
    return { status: "error", reason: "invalid_decision" };
  });

  app.post("/pilot/admin/protections/:id/premium-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = req.body as { amount?: number; reference?: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    const amount = Number(body.amount ?? protection.premium ?? 0);
    if (!Number.isFinite(amount) || amount <= 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_amount" };
    }
    await insertLedgerEntry(pool, {
      protectionId: params.id,
      entryType: "premium_settled",
      amount: new Decimal(amount).toFixed(10),
      reference: body.reference || null,
      settledAt: new Date().toISOString()
    });
    await insertAdminAction(pool, {
      protectionId: params.id,
      action: "premium_settled",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { amount, reference: body.reference || null }
    });
    return { status: "ok" };
  });

  app.post("/pilot/admin/protections/:id/payout-settled", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const body = req.body as { amount?: number; payoutTxRef?: string };
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    if (!protection.expiryPrice) {
      reply.code(409);
      return { status: "error", reason: "expiry_price_missing" };
    }
    const amount = Number(body.amount ?? protection.payoutDueAmount ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      reply.code(400);
      return { status: "error", reason: "invalid_amount" };
    }
    await insertLedgerEntry(pool, {
      protectionId: params.id,
      entryType: "payout_settled",
      amount: new Decimal(amount).toFixed(10),
      reference: body.payoutTxRef || null,
      settledAt: new Date().toISOString()
    });
    await patchProtection(pool, params.id, {
      payout_settled_amount: new Decimal(amount).toFixed(10),
      payout_settled_at: new Date().toISOString(),
      payout_tx_ref: body.payoutTxRef || null
    });
    await insertAdminAction(pool, {
      protectionId: params.id,
      action: "payout_settled",
      actor: auth.actor,
      actorIp: auth.actorIp,
      details: { amount, payoutTxRef: body.payoutTxRef || null }
    });
    return { status: "ok" };
  });

  app.get("/pilot/admin/protections/:id/ledger", async (req, reply) => {
    const params = req.params as { id: string };
    const auth = await requireAdmin(req, reply);
    if (!auth) return;
    const [protection, ledger] = await Promise.all([
      getProtection(pool, params.id),
      listLedgerForProtection(pool, params.id)
    ]);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection, ledger };
  });

  app.post("/pilot/internal/protections/:id/resolve-expiry", async (req, reply) => {
    const params = req.params as { id: string };
    await resolveAndPersistExpiry(params.id);
    const protection = await getProtection(pool, params.id);
    if (!protection) {
      reply.code(404);
      return { status: "error", reason: "not_found" };
    }
    return { status: "ok", protection };
  });

  const retryEveryMs = Math.max(5000, Number(process.env.EXPIRY_RETRY_INTERVAL_MS || "30000"));
  setInterval(async () => {
    try {
      const pending = await pool.query(
        `
          SELECT id FROM pilot_protections
          WHERE status IN ('active', 'awaiting_expiry_price')
            AND expiry_at <= NOW()
            AND expiry_price IS NULL
          ORDER BY expiry_at ASC
          LIMIT 50
        `
      );
      for (const row of pending.rows) {
        await resolveAndPersistExpiry(String(row.id));
      }
    } catch {
      // intentionally swallow to avoid crashing scheduler loop
    }
  }, retryEveryMs);
};

