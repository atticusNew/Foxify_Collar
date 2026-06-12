/**
 * Postgres-backed ProtectionStore — durable shadow-protection track record (survives restarts).
 *
 * Self-migrating (CREATE TABLE IF NOT EXISTS on first use), matching the v2 stack's convention.
 * Stores key columns for querying + the full cover as JSON text (universally supported, incl. pg-mem).
 */

import type { Pool } from "pg";
import type { ProtectionCover } from "./protectionLifecycle";
import type { ProtectionStore } from "./protectionService";

export class PostgresProtectionStore implements ProtectionStore {
  private ready: Promise<void> | null = null;
  constructor(private readonly pool: Pool) {}

  private ensureSchema(): Promise<void> {
    if (!this.ready) {
      this.ready = this.pool.query(`
        CREATE TABLE IF NOT EXISTS protection_covers (
          id TEXT PRIMARY KEY,
          foxify_ref TEXT,
          status TEXT NOT NULL,
          side TEXT NOT NULL,
          created_at_ms BIGINT NOT NULL,
          expires_at_ms BIGINT NOT NULL,
          data TEXT NOT NULL
        );
      `).then(async () => {
        try {
          await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_protection_covers_status ON protection_covers(status);`);
          await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_protection_covers_ref ON protection_covers(foxify_ref);`);
        } catch { /* pg-mem may not support every index */ }
      });
    }
    return this.ready;
  }

  async put(c: ProtectionCover): Promise<void> {
    await this.ensureSchema();
    await this.pool.query(
      `INSERT INTO protection_covers (id, foxify_ref, status, side, created_at_ms, expires_at_ms, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO UPDATE SET
         foxify_ref = EXCLUDED.foxify_ref, status = EXCLUDED.status, side = EXCLUDED.side,
         expires_at_ms = EXCLUDED.expires_at_ms, data = EXCLUDED.data`,
      [c.id, c.foxify_ref, c.status, c.side, c.created_at_ms, c.expires_at_ms, JSON.stringify(c)]
    );
  }

  private parse(rows: Array<{ data: string }>): ProtectionCover[] {
    return rows.map((r) => JSON.parse(r.data) as ProtectionCover);
  }

  async get(id: string): Promise<ProtectionCover | undefined> {
    await this.ensureSchema();
    const r = await this.pool.query<{ data: string }>(`SELECT data FROM protection_covers WHERE id = $1`, [id]);
    return r.rows.length ? this.parse(r.rows)[0] : undefined;
  }

  async findByRef(ref: string): Promise<ProtectionCover | undefined> {
    await this.ensureSchema();
    const r = await this.pool.query<{ data: string }>(
      `SELECT data FROM protection_covers WHERE foxify_ref = $1 ORDER BY created_at_ms DESC LIMIT 1`, [ref]
    );
    return r.rows.length ? this.parse(r.rows)[0] : undefined;
  }

  async list(): Promise<ProtectionCover[]> {
    await this.ensureSchema();
    const r = await this.pool.query<{ data: string }>(`SELECT data FROM protection_covers ORDER BY created_at_ms DESC`);
    return this.parse(r.rows);
  }

  async active(): Promise<ProtectionCover[]> {
    await this.ensureSchema();
    const r = await this.pool.query<{ data: string }>(`SELECT data FROM protection_covers WHERE status = 'active' ORDER BY created_at_ms DESC`);
    return this.parse(r.rows);
  }
}
