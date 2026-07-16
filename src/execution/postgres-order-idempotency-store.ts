import fs from 'node:fs';

import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

import type { OrderRequest } from '../api/polymarket-client.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  hashOrderRequest,
  normalizeIdempotencyKey,
  type IdempotentOrderRecord,
  type OrderIdempotencyPort,
} from './order-idempotency-store.js';

interface DatabaseOrderRow extends QueryResultRow {
  key: string;
  request_hash: string;
  state: IdempotentOrderRecord['state'];
  created_at: Date | string;
  updated_at: Date | string;
  exchange_order_id: string | null;
  terminal_status: IdempotentOrderRecord['terminalStatus'] | null;
  last_error: string | null;
}

export interface PgQueryable {
  query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>>;
}

export interface PgPoolClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgPoolClientLike>;
  end(): Promise<void>;
}

export interface PostgresOrderIdempotencyConfig {
  connectionString: string;
  ssl?: boolean;
  maxConnections?: number;
  /** Disable only when schema migrations are managed out of process. */
  initializeSchema?: boolean;
}

/**
 * PostgreSQL-backed logical-order journal. The primary-key insert is the
 * cross-machine claim; all state transitions use compare-and-set predicates so
 * stale workers cannot overwrite a newer state.
 */
export class PostgresOrderIdempotencyStore implements OrderIdempotencyPort {
  private schemaPromise: Promise<void> | undefined;
  private readonly pool: PgPoolLike;

  constructor(config: PostgresOrderIdempotencyConfig, pool?: PgPoolLike) {
    validateConnectionString(config.connectionString);
    if (
      config.maxConnections !== undefined &&
      (!Number.isInteger(config.maxConnections) || config.maxConnections < 1)
    ) {
      throw new Error('PostgreSQL idempotency maxConnections must be a positive integer');
    }
    const poolConfig: PoolConfig = {
      connectionString: config.connectionString,
      max: config.maxConnections ?? 5,
      application_name: 'polymarket-order-idempotency',
      ...(config.ssl ? { ssl: true } : {}),
    };
    this.pool = pool ?? (new Pool(poolConfig) as unknown as PgPoolLike);
    if (config.initializeSchema === false) this.schemaPromise = Promise.resolve();
  }

  async claim(key: string, order: OrderRequest): Promise<IdempotentOrderRecord> {
    await this.ensureSchema();
    const normalizedKey = normalizeIdempotencyKey(key);
    const requestHash = hashOrderRequest(order);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query<DatabaseOrderRow>(
        `INSERT INTO order_idempotency
          (key, request_hash, state, created_at, updated_at)
         VALUES ($1, $2, 'claimed', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         RETURNING *`,
        [normalizedKey, requestHash]
      );
      if (inserted.rowCount !== 1 || !inserted.rows[0]) {
        throw new Error('PostgreSQL order journal did not confirm the logical-order claim');
      }
      await client.query('COMMIT');
      return mapRow(inserted.rows[0]);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original claim failure.
      }
      if (isUniqueViolation(error)) {
        const existing = await client.query<DatabaseOrderRow>(
          'SELECT * FROM order_idempotency WHERE key = $1',
          [normalizedKey]
        );
        const record = existing.rows[0];
        const details = record
          ? `state=${record.state}${record.exchange_order_id ? `, exchangeOrderId=${record.exchange_order_id}` : ''}${record.request_hash !== requestHash ? ', requestHash=mismatch' : ''}`
          : 'state=unreadable';
        throw new Error(
          `Duplicate logical order blocked (idempotencyKey=${normalizedKey}, ${details}). Reconcile the existing order instead of resubmitting.`,
          { cause: error }
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markSubmitted(key: string, exchangeOrderId: string): Promise<void> {
    if (exchangeOrderId.trim() === '') {
      throw new Error('Exchange order id is required for idempotency journal update');
    }
    await this.compareAndSet(
      key,
      `UPDATE order_idempotency
       SET state = 'submitted', exchange_order_id = $2, updated_at = CURRENT_TIMESTAMP
       WHERE key = $1 AND state = 'claimed'
       RETURNING *`,
      [normalizeIdempotencyKey(key), exchangeOrderId],
      ['claimed'],
      'submitted'
    );
  }

  async markUnknown(key: string, error: unknown): Promise<void> {
    await this.ensureSchema();
    const normalizedKey = normalizeIdempotencyKey(key);
    const updated = await this.pool.query<DatabaseOrderRow>(
      `UPDATE order_idempotency
       SET state = 'unknown', last_error = $2, updated_at = CURRENT_TIMESTAMP
       WHERE key = $1 AND state IN ('claimed', 'unknown')
       RETURNING *`,
      [normalizedKey, getErrorMessage(error).slice(0, 2000)]
    );
    if (updated.rowCount === 1) return;
    const current = await this.get(normalizedKey);
    if (current?.state === 'submitted' || current?.state === 'terminal') return;
    if (!current) throw new Error(`Order idempotency key ${normalizedKey} was not claimed`);
    throw new Error(`Cannot mark ${current.state} order ${normalizedKey} unknown`);
  }

  async markTerminal(key: string, status: 'filled' | 'cancelled' | 'rejected'): Promise<void> {
    await this.compareAndSet(
      key,
      `UPDATE order_idempotency
       SET state = 'terminal', terminal_status = $2, updated_at = CURRENT_TIMESTAMP
       WHERE key = $1
         AND (state = 'submitted' OR (state = 'terminal' AND terminal_status = $2))
       RETURNING *`,
      [normalizeIdempotencyKey(key), status],
      ['submitted', 'terminal'],
      'terminal'
    );
  }

  async get(key: string): Promise<IdempotentOrderRecord | undefined> {
    await this.ensureSchema();
    const result = await this.pool.query<DatabaseOrderRow>(
      'SELECT * FROM order_idempotency WHERE key = $1',
      [normalizeIdempotencyKey(key)]
    );
    return result.rows[0] ? mapRow(result.rows[0]) : undefined;
  }

  async listUnresolved(): Promise<IdempotentOrderRecord[]> {
    await this.ensureSchema();
    const result = await this.pool.query<DatabaseOrderRow>(
      `SELECT * FROM order_idempotency
       WHERE state <> 'terminal'
       ORDER BY created_at ASC, key ASC`
    );
    return result.rows.map(mapRow);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async compareAndSet(
    key: string,
    sql: string,
    values: unknown[],
    allowedStates: IdempotentOrderRecord['state'][],
    targetState: IdempotentOrderRecord['state']
  ): Promise<void> {
    await this.ensureSchema();
    const updated = await this.pool.query<DatabaseOrderRow>(sql, values);
    if (updated.rowCount === 1) return;
    const current = await this.get(key);
    if (!current) throw new Error(`Order idempotency key ${key} was not claimed`);
    throw new Error(
      `Cannot mark ${current.state} order ${key} ${targetState}; expected ${allowedStates.join(' or ')}`
    );
  }

  private ensureSchema(): Promise<void> {
    this.schemaPromise ??= this.createSchema().catch((error: unknown) => {
      this.schemaPromise = undefined;
      throw new Error(`Failed to initialize PostgreSQL order journal: ${getErrorMessage(error)}`, {
        cause: error,
      });
    });
    return this.schemaPromise;
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS order_idempotency (
        key TEXT PRIMARY KEY,
        request_hash CHAR(64) NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('claimed', 'submitted', 'unknown', 'terminal')),
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        exchange_order_id TEXT,
        terminal_status TEXT CHECK (
          terminal_status IS NULL OR terminal_status IN ('filled', 'cancelled', 'rejected')
        ),
        last_error TEXT
      )`
    );
    await this.pool.query(
      `CREATE INDEX IF NOT EXISTS order_idempotency_unresolved_idx
       ON order_idempotency (created_at, key)
       WHERE state <> 'terminal'`
    );
  }
}

export function getPostgresIdempotencyConfigFromEnv(): PostgresOrderIdempotencyConfig | undefined {
  const connectionString = readSecret('ORDER_IDEMPOTENCY_DATABASE_URL');
  if (!connectionString) return undefined;
  const rawSsl = process.env.ORDER_IDEMPOTENCY_DATABASE_SSL?.trim();
  if (rawSsl !== undefined && rawSsl !== '' && rawSsl !== 'true' && rawSsl !== 'false') {
    throw new Error('ORDER_IDEMPOTENCY_DATABASE_SSL must be "true" or "false"');
  }
  const rawInitialize = process.env.ORDER_IDEMPOTENCY_DATABASE_INITIALIZE_SCHEMA?.trim();
  if (
    rawInitialize !== undefined &&
    rawInitialize !== '' &&
    rawInitialize !== 'true' &&
    rawInitialize !== 'false'
  ) {
    throw new Error('ORDER_IDEMPOTENCY_DATABASE_INITIALIZE_SCHEMA must be "true" or "false"');
  }
  return {
    connectionString,
    ...(rawSsl ? { ssl: rawSsl === 'true' } : {}),
    ...(rawInitialize ? { initializeSchema: rawInitialize === 'true' } : {}),
  };
}

function readSecret(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  const filePath = process.env[`${name}_FILE`]?.trim();
  if (direct && filePath) throw new Error(`${name} and ${name}_FILE are mutually exclusive`);
  if (direct) return direct;
  if (!filePath) return undefined;
  const value = fs.readFileSync(filePath, 'utf8').trim();
  if (!value) throw new Error(`${name}_FILE is empty`);
  return value;
}

function validateConnectionString(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch (error) {
    throw new Error('PostgreSQL order journal connection string is invalid', { cause: error });
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('PostgreSQL order journal requires a postgres:// connection string');
  }
}

function mapRow(row: DatabaseOrderRow): IdempotentOrderRecord {
  return {
    key: row.key,
    requestHash: row.request_hash,
    state: row.state,
    createdAt: new Date(row.created_at).getTime(),
    updatedAt: new Date(row.updated_at).getTime(),
    ...(row.exchange_order_id ? { exchangeOrderId: row.exchange_order_id } : {}),
    ...(row.terminal_status ? { terminalStatus: row.terminal_status } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}
