/**
 * Foxify webhook configuration storage (PR A7).
 *
 * Singleton config table: stores Foxify's webhook URL + the HMAC secret
 * used to sign outbound pair-closed notifications.
 *
 * Configured via POST /admin/foxify/v2/webhook-config. When unset, webhook
 * delivery is silently skipped (close still settles normally in DB).
 *
 * Schema:
 *   two_sided_webhook_config (singleton):
 *     webhook_url TEXT
 *     hmac_secret TEXT      ← stored encrypted-at-rest would be ideal; for
 *                              Phase 0 we rely on DB-level encryption + RBAC
 *     updated_at  TIMESTAMPTZ
 */

import type { Pool, PoolClient } from "pg";

export type WebhookConfig = {
  webhookUrl: string | null;
  hmacSecret: string | null;
  updatedAt: string | null;
};

export const ensureWebhookConfigSchema = async (pool: Pool): Promise<void> => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS two_sided_webhook_config (
      singleton_key TEXT PRIMARY KEY DEFAULT 'singleton' CHECK (singleton_key = 'singleton'),
      webhook_url TEXT,
      hmac_secret TEXT,
      updated_at TIMESTAMPTZ
    );
  `);
  await pool.query(`
    INSERT INTO two_sided_webhook_config (singleton_key) VALUES ('singleton') ON CONFLICT DO NOTHING;
  `);
};

export const getWebhookConfig = async (pool: Pool | PoolClient): Promise<WebhookConfig> => {
  const r = await pool.query(`SELECT webhook_url, hmac_secret, updated_at FROM two_sided_webhook_config WHERE singleton_key = 'singleton'`);
  const row = r.rows[0];
  return {
    webhookUrl: row?.webhook_url ?? null,
    hmacSecret: row?.hmac_secret ?? null,
    updatedAt: row?.updated_at ?? null
  };
};

export const setWebhookConfig = async (
  pool: Pool | PoolClient,
  webhookUrl: string,
  hmacSecret: string
): Promise<WebhookConfig> => {
  if (!webhookUrl || !hmacSecret) {
    throw new Error("webhookUrl and hmacSecret are required");
  }
  if (hmacSecret.length < 16) {
    throw new Error("hmacSecret must be at least 16 characters for security");
  }
  await pool.query(
    `UPDATE two_sided_webhook_config
     SET webhook_url = $1, hmac_secret = $2, updated_at = NOW()
     WHERE singleton_key = 'singleton'`,
    [webhookUrl, hmacSecret]
  );
  return getWebhookConfig(pool);
};

export const clearWebhookConfig = async (pool: Pool | PoolClient): Promise<WebhookConfig> => {
  await pool.query(
    `UPDATE two_sided_webhook_config
     SET webhook_url = NULL, hmac_secret = NULL, updated_at = NOW()
     WHERE singleton_key = 'singleton'`
  );
  return getWebhookConfig(pool);
};
