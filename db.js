import pg from 'pg';
import { CONFIG } from './config.js';

const { Pool } = pg;

// Strip unsupported params from Neon connection string
const cleanUrl = CONFIG.databaseUrl.replace(/[&?]channel_binding=[^&]*/g, '');

export const pool = new Pool({
  connectionString: cleanUrl,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ── Schema bootstrap ─────────────────────────────────────────────────────────
export async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS block_activity (
      block_height  BIGINT PRIMARY KEY,
      tx_count      INT     DEFAULT 0,
      contract_calls INT    DEFAULT 0,
      unique_senders INT    DEFAULT 0,
      gas_used      BIGINT  DEFAULT 0,
      events_count  INT     DEFAULT 0,
      indexed_at    TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contract_events (
      id               SERIAL PRIMARY KEY,
      block_height     BIGINT NOT NULL,
      tx_hash          TEXT,
      contract_address TEXT   NOT NULL,
      event_type       TEXT   NOT NULL,
      from_address     TEXT,
      raw_data         TEXT,
      decoded          JSONB,
      ts               TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (tx_hash, contract_address, event_type)
    );
    ALTER TABLE contract_events ADD COLUMN IF NOT EXISTS decoded JSONB;

    CREATE TABLE IF NOT EXISTS fee_snapshots (
      id           SERIAL PRIMARY KEY,
      block_height BIGINT,
      histogram    JSONB  NOT NULL,
      captured_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tokens (
      contract_address TEXT PRIMARY KEY,
      name             TEXT,
      symbol           TEXT,
      decimals         INT,
      total_supply     TEXT,
      icon             TEXT,
      fetch_status     TEXT NOT NULL DEFAULT 'pending',
      first_seen_block BIGINT,
      last_seen_block  BIGINT,
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS api_keys (
      key           TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      tier          TEXT NOT NULL DEFAULT 'free',
      request_count BIGINT NOT NULL DEFAULT 0,
      last_used_at  TIMESTAMPTZ,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS request_count BIGINT NOT NULL DEFAULT 0;
    ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at  TIMESTAMPTZ;

    CREATE INDEX IF NOT EXISTS idx_contract_events_block    ON contract_events (block_height DESC);
    CREATE INDEX IF NOT EXISTS idx_contract_events_type     ON contract_events (event_type);
    CREATE INDEX IF NOT EXISTS idx_contract_events_contract ON contract_events (contract_address);
    CREATE INDEX IF NOT EXISTS idx_fee_snapshots_block      ON fee_snapshots (block_height DESC);
    CREATE INDEX IF NOT EXISTS idx_tokens_status            ON tokens (fetch_status);

    CREATE TABLE IF NOT EXISTS webhooks (
      id               SERIAL PRIMARY KEY,
      api_key          TEXT NOT NULL,
      url              TEXT NOT NULL,
      secret           TEXT NOT NULL,
      event_type       TEXT,
      contract_address TEXT,
      active           BOOLEAN NOT NULL DEFAULT true,
      failure_count    INT     NOT NULL DEFAULT 0,
      last_fired_at    TIMESTAMPTZ,
      created_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_webhooks_key    ON webhooks (api_key);
    CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks (active, event_type, contract_address);

    CREATE TABLE IF NOT EXISTS oracle_prices (
      id          SERIAL PRIMARY KEY,
      symbol      TEXT          NOT NULL,
      price       NUMERIC(20,8) NOT NULL,
      sources     JSONB         NOT NULL,
      confidence  NUMERIC(8,6)  NOT NULL,
      signature   TEXT          NOT NULL,
      captured_at TIMESTAMPTZ   DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_oracle_prices_symbol ON oracle_prices (symbol, captured_at DESC);
  `);
  console.log('[DB] Schema ready');
}

// Latest fee + mempool snapshot
export async function getLatestFee() {
  const r = await pool.query(`
    SELECT block_height, median_fee_scaled, mempool_count, tx_id, submitted_at
    FROM oracle_feeds
    ORDER BY block_height DESC
    LIMIT 1
  `);
  return r.rows[0] || null;
}

// Last N blocks of fee history
export async function getFeeHistory(limit = 50) {
  const r = await pool.query(`
    SELECT block_height, median_fee_scaled, mempool_count, submitted_at
    FROM oracle_feeds
    ORDER BY block_height DESC
    LIMIT $1
  `, [Math.min(limit, 500)]);
  return r.rows;
}

// Fee stats (min/max/avg)
export async function getFeeStats() {
  const r = await pool.query(`
    SELECT
      MIN(median_fee_scaled)::float / 100 AS min_fee,
      MAX(median_fee_scaled)::float / 100 AS max_fee,
      AVG(median_fee_scaled)::float / 100 AS avg_fee,
      MIN(mempool_count)                  AS min_mempool,
      MAX(mempool_count)                  AS max_mempool,
      AVG(mempool_count)::int             AS avg_mempool,
      COUNT(*)::int                       AS total_blocks
    FROM oracle_feeds
  `);
  return r.rows[0];
}

// ── Block activity ───────────────────────────────────────────────────────────
export async function getBlockActivity(limit = 20) {
  const r = await pool.query(`
    SELECT block_height, tx_count, contract_calls, unique_senders, gas_used, events_count, indexed_at
    FROM block_activity
    ORDER BY block_height DESC
    LIMIT $1
  `, [Math.min(limit, 200)]);
  return r.rows;
}

export async function getLatestBlockActivity() {
  const r = await pool.query(`
    SELECT block_height, tx_count, contract_calls, unique_senders, gas_used, events_count, indexed_at
    FROM block_activity
    ORDER BY block_height DESC
    LIMIT 1
  `);
  return r.rows[0] || null;
}

export async function getActivityStats() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int                   AS total_blocks_indexed,
      SUM(tx_count)::bigint           AS total_txs,
      SUM(contract_calls)::bigint     AS total_contract_calls,
      SUM(events_count)::bigint       AS total_events,
      AVG(tx_count)::float            AS avg_txs_per_block,
      AVG(contract_calls)::float      AS avg_calls_per_block,
      MAX(gas_used)::bigint           AS peak_gas
    FROM block_activity
  `);
  return r.rows[0];
}

// ── Contract events ──────────────────────────────────────────────────────────
export async function getRecentEvents(limit = 50, eventType = null, cursor = null) {
  const params  = [Math.min(limit, 200)];
  const filters = [];
  if (cursor)    { params.push(cursor);    filters.push(`id < $${params.length}`); }
  if (eventType) { params.push(eventType); filters.push(`event_type = $${params.length}`); }
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const r = await pool.query(`
    SELECT id, block_height, tx_hash, contract_address, event_type, from_address, decoded, ts
    FROM contract_events
    ${where}
    ORDER BY id DESC
    LIMIT $1
  `, params);
  return r.rows;
}

export async function getTopContracts(limit = 10) {
  const r = await pool.query(`
    SELECT
      contract_address,
      COUNT(*)::int           AS interaction_count,
      COUNT(DISTINCT event_type)::int AS unique_event_types,
      MAX(block_height)       AS last_active_block
    FROM contract_events
    GROUP BY contract_address
    ORDER BY interaction_count DESC
    LIMIT $1
  `, [Math.min(limit, 50)]);
  return r.rows;
}

export async function getEventTypeSummary() {
  const r = await pool.query(`
    SELECT event_type, COUNT(*)::int AS count
    FROM contract_events
    GROUP BY event_type
    ORDER BY count DESC
    LIMIT 20
  `);
  return r.rows;
}

// ── Fee histogram ────────────────────────────────────────────────────────────
export async function getLatestHistogram() {
  const r = await pool.query(`
    SELECT block_height, histogram, captured_at
    FROM fee_snapshots
    ORDER BY id DESC
    LIMIT 1
  `);
  return r.rows[0] || null;
}

// ── Token registry ───────────────────────────────────────────────────────────
export async function upsertToken(contractAddress, blockHeight) {
  await pool.query(`
    INSERT INTO tokens (contract_address, first_seen_block, last_seen_block)
    VALUES ($1, $2, $2)
    ON CONFLICT (contract_address) DO UPDATE
      SET last_seen_block = GREATEST(tokens.last_seen_block, $2)
  `, [contractAddress, blockHeight]);
}

export async function updateTokenMetadata(contractAddress, meta) {
  await pool.query(`
    UPDATE tokens
    SET name = $2, symbol = $3, decimals = $4, total_supply = $5,
        icon = $6, fetch_status = $7, updated_at = NOW()
    WHERE contract_address = $1
  `, [contractAddress, meta.name, meta.symbol, meta.decimals,
      meta.total_supply, meta.icon, meta.fetch_status]);
}

export async function getPendingTokens(limit = 50) {
  const r = await pool.query(`
    SELECT contract_address FROM tokens
    WHERE fetch_status = 'pending'
    ORDER BY first_seen_block DESC
    LIMIT $1
  `, [limit]);
  return r.rows.map(r => r.contract_address);
}

export async function getToken(address) {
  const r = await pool.query(`
    SELECT t.*,
      COUNT(e.id)::int          AS total_events,
      MAX(e.block_height)       AS last_event_block
    FROM tokens t
    LEFT JOIN contract_events e ON e.contract_address = t.contract_address
    WHERE t.contract_address = $1
    GROUP BY t.contract_address
  `, [address]);
  return r.rows[0] || null;
}

export async function getTokens({ limit = 20, cursor = null } = {}) {
  const params = [Math.min(limit, 100)];
  const where  = cursor ? `WHERE t.contract_address < $2` : '';
  if (cursor) params.push(cursor);
  const r = await pool.query(`
    SELECT t.contract_address, t.name, t.symbol, t.decimals,
           t.fetch_status, t.first_seen_block, t.last_seen_block,
           COUNT(e.id)::int AS total_events
    FROM tokens t
    LEFT JOIN contract_events e ON e.contract_address = t.contract_address
    ${where}
    GROUP BY t.contract_address
    ORDER BY total_events DESC
    LIMIT $1
  `, params);
  return r.rows;
}

export async function getContractEvents({ address, limit = 50, cursor = null, type = null } = {}) {
  const params = [address, Math.min(limit, 200)];
  const filters = ['contract_address = $1'];
  if (cursor) { params.push(cursor); filters.push(`id < $${params.length}`); }
  if (type)   { params.push(type);   filters.push(`event_type = $${params.length}`); }
  const r = await pool.query(`
    SELECT id, block_height, tx_hash, event_type, from_address, decoded, ts
    FROM contract_events
    WHERE ${filters.join(' AND ')}
    ORDER BY id DESC
    LIMIT $2
  `, params);
  return r.rows;
}

export async function getContractStats(address) {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int                          AS total_events,
      COUNT(DISTINCT event_type)::int        AS unique_event_types,
      COUNT(DISTINCT block_height)::int      AS active_blocks,
      MIN(block_height)                      AS first_block,
      MAX(block_height)                      AS last_block,
      array_agg(DISTINCT event_type)         AS event_types
    FROM contract_events
    WHERE contract_address = $1
  `, [address]);
  return r.rows[0] || null;
}

// ── API key management ────────────────────────────────────────────────────────
export async function createApiKey(key, name, tier = 'free') {
  await pool.query(
    `INSERT INTO api_keys (key, name, tier) VALUES ($1, $2, $3)`,
    [key, name, tier],
  );
}

export async function getApiKey(key) {
  const r = await pool.query(
    `SELECT key, name, tier, created_at FROM api_keys WHERE key = $1`,
    [key],
  );
  return r.rows[0] || null;
}

export async function listApiKeys() {
  const r = await pool.query(
    `SELECT name, tier, request_count, last_used_at, created_at FROM api_keys ORDER BY request_count DESC`,
  );
  return r.rows;
}

export async function incrementApiKeyUsage(key) {
  await pool.query(
    `UPDATE api_keys SET request_count = request_count + 1, last_used_at = NOW() WHERE key = $1`,
    [key],
  );
}

// ── Oracle prices ─────────────────────────────────────────────────────────────
export async function storeOraclePrice(symbol, price, sources, confidence, signature) {
  const r = await pool.query(
    `INSERT INTO oracle_prices (symbol, price, sources, confidence, signature)
     VALUES ($1, $2, $3::jsonb, $4, $5) RETURNING id, captured_at`,
    [symbol, price, JSON.stringify(sources), confidence, signature],
  );
  return r.rows[0];
}

export async function getLatestOraclePrice(symbol = 'BTC/USD') {
  const r = await pool.query(
    `SELECT id, symbol, price::float, sources, confidence::float, signature, captured_at
     FROM oracle_prices WHERE symbol = $1 ORDER BY id DESC LIMIT 1`,
    [symbol],
  );
  return r.rows[0] || null;
}

export async function getOraclePriceHistory(symbol = 'BTC/USD', limit = 50) {
  const r = await pool.query(
    `SELECT id, symbol, price::float, confidence::float, captured_at
     FROM oracle_prices WHERE symbol = $1 ORDER BY id DESC LIMIT $2`,
    [symbol, Math.min(limit, 500)],
  );
  return r.rows;
}

export async function getOracleSymbols() {
  const r = await pool.query(
    `SELECT DISTINCT ON (symbol) symbol, price::float, confidence::float, captured_at
     FROM oracle_prices ORDER BY symbol, captured_at DESC`,
  );
  return r.rows;
}

// ── Webhooks ──────────────────────────────────────────────────────────────────
export async function createWebhook(apiKey, url, secret, eventType, contractAddress) {
  const r = await pool.query(
    `INSERT INTO webhooks (api_key, url, secret, event_type, contract_address)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [apiKey, url, secret, eventType || null, contractAddress || null],
  );
  return r.rows[0];
}

export async function listWebhooks(apiKey) {
  const r = await pool.query(
    `SELECT id, url, event_type, contract_address, active, failure_count, last_fired_at, created_at
     FROM webhooks WHERE api_key = $1 ORDER BY id DESC`,
    [apiKey],
  );
  return r.rows;
}

export async function deleteWebhook(id, apiKey) {
  const r = await pool.query(
    `DELETE FROM webhooks WHERE id = $1 AND api_key = $2 RETURNING id`,
    [id, apiKey],
  );
  return r.rowCount > 0;
}

export async function toggleWebhook(id, apiKey, active) {
  const r = await pool.query(
    `UPDATE webhooks SET active = $3, failure_count = 0 WHERE id = $1 AND api_key = $2 RETURNING id`,
    [id, apiKey, active],
  );
  return r.rowCount > 0;
}

export async function getMatchingWebhooks(eventType, contractAddress) {
  const r = await pool.query(
    `SELECT id, url, secret
     FROM webhooks
     WHERE active = true
       AND (event_type IS NULL OR event_type = $1)
       AND (contract_address IS NULL OR contract_address = $2)`,
    [eventType, contractAddress],
  );
  return r.rows;
}

export async function recordWebhookDelivery(id, success) {
  if (success) {
    await pool.query(
      `UPDATE webhooks SET last_fired_at = NOW(), failure_count = 0 WHERE id = $1`,
      [id],
    );
  } else {
    await pool.query(
      `UPDATE webhooks
       SET failure_count = failure_count + 1,
           active = CASE WHEN failure_count + 1 >= 10 THEN false ELSE active END
       WHERE id = $1`,
      [id],
    );
  }
}

export async function countWebhooks(apiKey) {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS n FROM webhooks WHERE api_key = $1`,
    [apiKey],
  );
  return r.rows[0].n;
}

// ── Bet activity summary (public, no wallet data)
export async function getBetStats() {
  const r = await pool.query(`
    SELECT
      COUNT(*)::int                                    AS total_bets,
      COUNT(*) FILTER (WHERE status = 0)::int          AS active_bets,
      COUNT(*) FILTER (WHERE won = true)::int          AS total_wins,
      COUNT(*) FILTER (WHERE won = false)::int         AS total_losses,
      COALESCE(SUM(payout::numeric) FILTER (WHERE won = true), 0)::text AS total_paid_out
    FROM bets
  `);
  return r.rows[0];
}
