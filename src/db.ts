/**
 * PostgreSQL database layer for BlockFeed.
 *
 * Tables:
 *   oracle_feeds       — Bitcoin block data submitted by keeper
 *   block_activity     — OPNet block stats (tx count, events, contract calls)
 *   contract_events    — every contract event with decoded calldata
 *   tokens             — OP20 token metadata registry
 *   oracle_prices      — multi-symbol price oracle history
 *   webhooks           — subscriber webhook registrations
 *   api_keys           — hashed API keys with rate limits
 *   bets               — OPBET bet registry (mirrored from keeper)
 *   oracle_feeds_btc   — keeper-submitted Bitcoin oracle data
 */

import pg from 'pg';
import type {
    DbBlockActivity, DbContractEvent, DbToken, DbOraclePrice, AddressOverview,
    DbWebhook, DbApiKey, DbOracleFeed, OracleInterval,
} from './types.js';

const { Pool } = pg;

export const pool = new Pool({
    connectionString: process.env['DATABASE_URL'],
    ssl:              { rejectUnauthorized: false },
    max:              20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
});

// ── Schema bootstrap ──────────────────────────────────────────────────────────
export async function ensureSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS oracle_feeds (
            id                SERIAL PRIMARY KEY,
            block_height      INTEGER     NOT NULL,
            median_fee_scaled INTEGER,
            mempool_count     INTEGER,
            tx_id             TEXT,
            submitted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (block_height)
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_feeds_height ON oracle_feeds (block_height DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_oracle_feeds_unique_height ON oracle_feeds (block_height);

        CREATE TABLE IF NOT EXISTS block_activity (
            id              SERIAL PRIMARY KEY,
            block_height    INTEGER     NOT NULL UNIQUE,
            tx_count        INTEGER     NOT NULL DEFAULT 0,
            contract_calls  INTEGER     NOT NULL DEFAULT 0,
            events_count    INTEGER     NOT NULL DEFAULT 0,
            indexed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_block_activity_height ON block_activity (block_height DESC);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_block_activity_unique_height ON block_activity (block_height);

        CREATE TABLE IF NOT EXISTS contract_events (
            id               BIGSERIAL   PRIMARY KEY,
            block_height     INTEGER     NOT NULL,
            tx_hash          TEXT        NOT NULL,
            contract_address TEXT        NOT NULL,
            event_type       TEXT        NOT NULL,
            from_address     TEXT,
            decoded          JSONB,
            ts               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (block_height, tx_hash, contract_address, event_type)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_unique_key ON contract_events (block_height, tx_hash, contract_address, event_type);
        CREATE INDEX IF NOT EXISTS idx_events_contract   ON contract_events (contract_address, id DESC);
        CREATE INDEX IF NOT EXISTS idx_events_type       ON contract_events (event_type, id DESC);
        CREATE INDEX IF NOT EXISTS idx_events_from       ON contract_events (from_address, id DESC);
        CREATE INDEX IF NOT EXISTS idx_events_tx         ON contract_events (tx_hash);
        CREATE INDEX IF NOT EXISTS idx_events_ts         ON contract_events (ts DESC);

        CREATE TABLE IF NOT EXISTS tokens (
            contract_address TEXT PRIMARY KEY,
            name             TEXT,
            symbol           TEXT,
            decimals         INTEGER,
            total_supply     TEXT,
            fetch_status     TEXT     DEFAULT 'pending',
            fetched_at       TIMESTAMPTZ
        );

        CREATE TABLE IF NOT EXISTS oracle_prices (
            id           SERIAL PRIMARY KEY,
            symbol       TEXT        NOT NULL,
            price        NUMERIC     NOT NULL,
            sources      JSONB,
            confidence   NUMERIC,
            signature    TEXT,
            captured_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_oracle_prices_symbol ON oracle_prices (symbol, captured_at DESC);

        CREATE TABLE IF NOT EXISTS webhooks (
            id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
            key_id          UUID        NOT NULL,
            url             TEXT        NOT NULL,
            events          TEXT[]      NOT NULL,
            contract_filter TEXT,
            active          BOOLEAN     NOT NULL DEFAULT TRUE,
            created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            delivery_count  INTEGER     NOT NULL DEFAULT 0,
            last_delivery_at TIMESTAMPTZ,
            last_status_code INTEGER,
            last_event_id   BIGINT      NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS api_keys (
            id          UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
            key_hash    TEXT    NOT NULL UNIQUE,
            label       TEXT    NOT NULL DEFAULT 'default',
            rate_limit  INTEGER NOT NULL DEFAULT 100,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS bets (
            bet_id            INTEGER PRIMARY KEY,
            bet_type          SMALLINT,
            param1            TEXT,
            param2            TEXT,
            amount            TEXT,
            end_block         INTEGER,
            status            SMALLINT NOT NULL DEFAULT 0,
            won               BOOLEAN,
            payout            TEXT,
            wallet            TEXT,
            token_symbol      TEXT,
            owner_hex         TEXT,
            contract_address  TEXT,
            placed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            resolved_at       TIMESTAMPTZ,
            resolve_tx        TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_bets_status ON bets (status);
    `);

    // ── Migrations (idempotent column additions for existing deployments) ────
    await pool.query(`
        ALTER TABLE tokens
            ADD COLUMN IF NOT EXISTS fetch_status TEXT DEFAULT 'pending',
            ADD COLUMN IF NOT EXISTS fetched_at   TIMESTAMPTZ;
        ALTER TABLE webhooks
            ADD COLUMN IF NOT EXISTS last_event_id BIGINT NOT NULL DEFAULT 0;
    `);

    console.log('[DB] Schema ready');
}

// ── Oracle feeds ──────────────────────────────────────────────────────────────
export async function insertFeedRow(blockHeight: number, medianFeeScaled: number, mempoolCount: number): Promise<void> {
    await pool.query(
        `INSERT INTO oracle_feeds (block_height, median_fee_scaled, mempool_count)
         VALUES ($1, $2, $3)
         ON CONFLICT (block_height) DO UPDATE
           SET median_fee_scaled = EXCLUDED.median_fee_scaled,
               mempool_count     = EXCLUDED.mempool_count,
               submitted_at      = NOW()`,
        [blockHeight, medianFeeScaled, mempoolCount],
    );
}

export async function getLatestFee(): Promise<DbOracleFeed | null> {
    const r = await pool.query<DbOracleFeed>(
        `SELECT * FROM oracle_feeds ORDER BY block_height DESC LIMIT 1`,
    );
    return r.rows[0] ?? null;
}

export async function getFeeHistory(limit: number): Promise<DbOracleFeed[]> {
    const r = await pool.query<DbOracleFeed>(
        `SELECT * FROM oracle_feeds ORDER BY block_height DESC LIMIT $1`,
        [Math.min(limit, 500)],
    );
    return r.rows;
}

export async function getFeeStats(): Promise<unknown> {
    const r = await pool.query(`
        SELECT
            MIN(median_fee_scaled)::float / 100 AS min_fee,
            MAX(median_fee_scaled)::float / 100 AS max_fee,
            AVG(median_fee_scaled)::float / 100 AS avg_fee,
            MIN(mempool_count)::int           AS min_mempool,
            MAX(mempool_count)::int           AS max_mempool,
            AVG(mempool_count)::float         AS avg_mempool,
            COUNT(*)::int                     AS total_feeds
        FROM oracle_feeds
        WHERE submitted_at > NOW() - INTERVAL '7 days'
    `);
    return r.rows[0];
}

export async function getLatestHistogram(): Promise<unknown[]> {
    const r = await pool.query(`
        SELECT
            block_height,
            median_fee_scaled,
            mempool_count,
            submitted_at
        FROM oracle_feeds
        ORDER BY block_height DESC
        LIMIT 144
    `);
    return r.rows;
}

// ── Block activity ────────────────────────────────────────────────────────────
export async function upsertBlockActivity(height: number, eventsCount: number, txCount = 0, contractCalls = 0): Promise<void> {
    await pool.query(
        `INSERT INTO block_activity (block_height, events_count, tx_count, contract_calls)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (block_height) DO UPDATE
           SET events_count   = GREATEST(EXCLUDED.events_count, block_activity.events_count),
               tx_count       = GREATEST(EXCLUDED.tx_count,     block_activity.tx_count),
               contract_calls = GREATEST(EXCLUDED.contract_calls, block_activity.contract_calls)`,
        [height, eventsCount, txCount, contractCalls],
    );
}

export async function getLatestBlockActivity(): Promise<DbBlockActivity | null> {
    const r = await pool.query<DbBlockActivity>(
        `SELECT * FROM block_activity ORDER BY block_height DESC LIMIT 1`,
    );
    return r.rows[0] ?? null;
}

export async function getBlockActivity(limit: number): Promise<DbBlockActivity[]> {
    const r = await pool.query<DbBlockActivity>(
        `SELECT * FROM block_activity ORDER BY block_height DESC LIMIT $1`,
        [Math.min(limit, 200)],
    );
    return r.rows;
}

export async function getActivityStats(): Promise<unknown> {
    const [actRow, contractRow] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*)::int           AS total_blocks,
                SUM(tx_count)::int      AS total_txs,
                SUM(events_count)::int  AS total_events,
                AVG(tx_count)::float    AS avg_tx_per_block,
                MAX(block_height)::int  AS latest_block
            FROM block_activity
        `),
        pool.query(`SELECT COUNT(DISTINCT contract_address)::int AS total_contracts FROM contract_events`),
    ]);
    return { ...actRow.rows[0], total_contracts: contractRow.rows[0]?.total_contracts ?? 0 };
}

// ── Contract events ───────────────────────────────────────────────────────────
export async function upsertContractEvent(params: {
    blockHeight: number;
    txHash: string;
    contractAddress: string;
    eventType: string;
    fromAddress: string | null;
    decoded: Record<string, unknown> | null;
}): Promise<DbContractEvent | null> {
    const { blockHeight, txHash, contractAddress, eventType, fromAddress, decoded } = params;
    const r = await pool.query<DbContractEvent>(
        `INSERT INTO contract_events (block_height, tx_hash, contract_address, event_type, from_address, decoded)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (block_height, tx_hash, contract_address, event_type) DO NOTHING
         RETURNING *`,
        [blockHeight, txHash, contractAddress, eventType, fromAddress, decoded ? JSON.stringify(decoded) : null],
    );
    return r.rows[0] ?? null;
}

export async function getRecentEvents(limit: number, type: string | null, cursor: number | null): Promise<DbContractEvent[]> {
    const params: (number | string | null)[] = [Math.min(limit, 200)];
    const typeClause   = type   ? `AND event_type = $${params.push(type)}`   : '';
    const cursorClause = cursor ? `AND id < $${params.push(cursor)}`          : '';
    const r = await pool.query<DbContractEvent>(
        `SELECT * FROM contract_events WHERE TRUE ${typeClause} ${cursorClause} ORDER BY id DESC LIMIT $1`,
        params,
    );
    return r.rows;
}

export async function getContractEvents(address: string, limit: number, type: string | null, cursor: number | null): Promise<DbContractEvent[]> {
    const params: (string | number | null)[] = [address, Math.min(limit, 200)];
    const typeClause   = type   ? `AND event_type = $${params.push(type)}`   : '';
    const cursorClause = cursor ? `AND id < $${params.push(cursor)}`          : '';
    const r = await pool.query<DbContractEvent>(
        `SELECT * FROM contract_events WHERE contract_address = $1 ${typeClause} ${cursorClause} ORDER BY id DESC LIMIT $2`,
        params,
    );
    return r.rows;
}

export async function getContractStats(address: string): Promise<unknown> {
    const r = await pool.query(
        `SELECT
            COUNT(*)::int                AS total_events,
            COUNT(DISTINCT tx_hash)::int AS total_txs,
            COUNT(DISTINCT event_type)::int AS event_types,
            MIN(block_height)::int       AS first_seen,
            MAX(block_height)::int       AS last_seen
         FROM contract_events WHERE contract_address = $1`,
        [address],
    );
    return r.rows[0] ?? null;
}

export async function getTopContracts(limit: number): Promise<unknown[]> {
    const r = await pool.query(
        `SELECT
            contract_address,
            COUNT(*)::int                AS event_count,
            COUNT(DISTINCT tx_hash)::int AS tx_count,
            MAX(block_height)::int       AS last_active_block
         FROM contract_events
         GROUP BY contract_address
         ORDER BY event_count DESC
         LIMIT $1`,
        [Math.min(limit, 50)],
    );
    return r.rows;
}

export async function getEventTypeSummary(): Promise<unknown[]> {
    const r = await pool.query(
        `SELECT event_type, COUNT(*)::int AS count
         FROM contract_events
         GROUP BY event_type ORDER BY count DESC`,
    );
    return r.rows;
}

export async function getTxByHash(txHash: string): Promise<DbContractEvent[]> {
    const r = await pool.query<DbContractEvent>(
        `SELECT * FROM contract_events WHERE tx_hash = $1 ORDER BY id ASC`,
        [txHash],
    );
    return r.rows;
}

// ── Tokens ────────────────────────────────────────────────────────────────────
export async function upsertToken(contractAddress: string): Promise<void> {
    await pool.query(
        `INSERT INTO tokens (contract_address) VALUES ($1) ON CONFLICT (contract_address) DO NOTHING`,
        [contractAddress],
    );
}

export async function getToken(address: string): Promise<DbToken | null> {
    const r = await pool.query<DbToken>(`SELECT * FROM tokens WHERE contract_address = $1`, [address]);
    return r.rows[0] ?? null;
}

export async function getTokens(limit: number): Promise<DbToken[]> {
    const r = await pool.query<DbToken>(
        `SELECT * FROM tokens WHERE symbol IS NOT NULL ORDER BY symbol ASC LIMIT $1`,
        [Math.min(limit, 100)],
    );
    return r.rows;
}

export async function getTokenHolders(contractAddress: string, limit: number): Promise<unknown[]> {
    const r = await pool.query(
        `WITH transfers AS (
            SELECT decoded->>'to'   AS addr, (decoded->>'amount')::numeric AS amount FROM contract_events
            WHERE contract_address = $1 AND event_type = 'Transferred' AND decoded->>'to' IS NOT NULL
            UNION ALL
            SELECT decoded->>'from' AS addr, -1 * (decoded->>'amount')::numeric AS amount FROM contract_events
            WHERE contract_address = $1 AND event_type = 'Transferred' AND decoded->>'from' IS NOT NULL
         )
         SELECT addr AS address, SUM(amount)::text AS net_balance,
                COUNT(*) FILTER (WHERE amount > 0)::int AS receives,
                COUNT(*) FILTER (WHERE amount < 0)::int AS sends
         FROM transfers WHERE addr IS NOT NULL AND addr != '0x' || repeat('0',64)
         GROUP BY addr HAVING SUM(amount) > 0
         ORDER BY SUM(amount) DESC LIMIT $2`,
        [contractAddress, Math.min(limit, 200)],
    );
    return r.rows;
}

// ── Oracle prices ─────────────────────────────────────────────────────────────
export async function storeOraclePrice(
    symbol: string, price: number,
    sources: Record<string, number>,
    confidence: number, signature: string,
): Promise<DbOraclePrice> {
    const r = await pool.query<DbOraclePrice>(
        `INSERT INTO oracle_prices (symbol, price, sources, confidence, signature)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [symbol, price, JSON.stringify(sources), confidence, signature],
    );
    return r.rows[0]!;
}

export async function getLatestOraclePrice(symbol: string): Promise<DbOraclePrice | null> {
    const r = await pool.query<DbOraclePrice>(
        `SELECT * FROM oracle_prices WHERE symbol = $1 ORDER BY captured_at DESC LIMIT 1`,
        [symbol],
    );
    return r.rows[0] ?? null;
}

export async function getOraclePriceHistory(symbol: string, limit: number): Promise<DbOraclePrice[]> {
    const r = await pool.query<DbOraclePrice>(
        `SELECT * FROM oracle_prices WHERE symbol = $1 ORDER BY captured_at DESC LIMIT $2`,
        [symbol, Math.min(limit, 500)],
    );
    return r.rows;
}

export async function getOracleSymbols(): Promise<string[]> {
    const r = await pool.query<{ symbol: string }>(
        `SELECT DISTINCT symbol FROM oracle_prices ORDER BY symbol`,
    );
    return r.rows.map(r => r.symbol);
}

export async function getAllLatestOraclePrices(): Promise<DbOraclePrice[]> {
    const r = await pool.query<DbOraclePrice>(`
        SELECT DISTINCT ON (symbol) id, symbol, price::float AS price, sources, confidence::float AS confidence, signature, captured_at
        FROM oracle_prices ORDER BY symbol, captured_at DESC
    `);
    return r.rows;
}

export async function getOhlcv(symbol: string, interval: string, limit: number): Promise<unknown[]> {
    const INTERVALS: Record<string, string> = {
        '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes',
        '1h': '1 hour',   '4h': '4 hours',   '1d': '1 day',
    };
    const trunc = INTERVALS[interval as OracleInterval] ?? '1 hour';
    const r = await pool.query(
        `SELECT
            date_trunc($3, captured_at)                                AS ts,
            (ARRAY_AGG(price ORDER BY captured_at ASC))[1]::float      AS open,
            MAX(price)::float                                          AS high,
            MIN(price)::float                                          AS low,
            (ARRAY_AGG(price ORDER BY captured_at DESC))[1]::float     AS close,
            COUNT(*)::int                                              AS ticks
         FROM oracle_prices WHERE symbol = $1
         GROUP BY date_trunc($3, captured_at)
         ORDER BY ts DESC LIMIT $2`,
        [symbol, Math.min(limit, 500), trunc],
    );
    return r.rows.reverse();
}

// ── Address analytics ─────────────────────────────────────────────────────────

// Bech32 charset for decoding opt1/bc1p/bc1q addresses
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32ToBytes(addr: string): Buffer | null {
    try {
        const lower = addr.toLowerCase();
        const sep = lower.lastIndexOf('1');
        if (sep < 1 || sep + 7 > lower.length) return null;
        // decode base32 chars (skip the separator '1')
        const data5: number[] = [];
        for (let i = sep + 1; i < lower.length; i++) {
            const v = BECH32_CHARSET.indexOf(lower[i]);
            if (v < 0) return null;
            data5.push(v);
        }
        // strip 6-char checksum, first byte is witness version
        const payload5 = data5.slice(0, -6).slice(1);
        // convert 5-bit groups to 8-bit bytes
        let acc = 0, bits = 0;
        const bytes: number[] = [];
        for (const v of payload5) {
            acc = (acc << 5) | v;
            bits += 5;
            if (bits >= 8) { bits -= 8; bytes.push((acc >> bits) & 0xff); }
        }
        // Accept 20-byte (P2WPKH) and 32-byte (P2TR/OPNet) payloads
        if (bytes.length === 32 || bytes.length === 20) return Buffer.from(bytes);
        return null;
    } catch {
        return null;
    }
}

/**
 * Convert any address form to the base64 used in contract_events.from_address.
 * Accepts: bech32 opt1/bc1*, legacy BTC 1.../3..., 64-char hex, or base64 as-is.
 */
function toBase64Address(address: string): string {
    if (/^(opt1|bc1|tb1)/i.test(address)) {
        const bytes = bech32ToBytes(address);
        if (bytes) return bytes.toString('base64');
    }
    // 0x + 64 hex (OPNet wallet shown on OPScan, stored as base64 in from_address)
    if (/^0x[0-9a-fA-F]{64}$/i.test(address)) {
        return Buffer.from(address.slice(2), 'hex').toString('base64');
    }
    if (/^[0-9a-fA-F]{64}$/.test(address)) {
        return Buffer.from(address, 'hex').toString('base64');
    }
    // Legacy BTC addresses (P2PKH / P2SH) — pass through as raw string for direct match
    if (/^[13][a-zA-Z0-9]{25,34}$/.test(address)) {
        return address;
    }
    return address; // already base64 or unknown — pass through
}

/**
 * Convert any address form to the 0x-prefixed hex used in contract_events.contract_address.
 * Returns null if the address cannot be decoded.
 */
function toHexAddress(address: string): string | null {
    if (/^(opt1|bc1|tb1)/i.test(address)) {
        const bytes = bech32ToBytes(address);
        if (bytes) return '0x' + bytes.toString('hex');
    }
    if (/^[0-9a-fA-F]{64}$/.test(address)) {
        return '0x' + address.toLowerCase();
    }
    if (/^0x[0-9a-fA-F]{40,64}$/i.test(address)) {
        return address.toLowerCase();
    }
    return null;
}


export async function getAddressOverview(address: string): Promise<Omit<AddressOverview, 'address' | 'top_tokens'> | null> {
    const b64  = toBase64Address(address);
    const hex  = toHexAddress(address);
    const r = await pool.query(
        `SELECT COUNT(DISTINCT tx_hash)::int AS tx_count,
                COUNT(DISTINCT contract_address)::int AS contracts_touched,
                MIN(block_height)::bigint AS first_seen_block,
                MAX(block_height)::bigint AS last_seen_block,
                COUNT(*)::int AS total_events,
                COUNT(*) FILTER (WHERE from_address = $1)::int AS wallet_event_count,
                COUNT(*) FILTER (WHERE $2::text IS NOT NULL AND contract_address = $2)::int AS contract_event_count
         FROM contract_events
         WHERE from_address = $1 OR ($2::text IS NOT NULL AND contract_address = $2)`,
        [b64, hex],
    );
    const row = r.rows[0];
    if (!row || (row.tx_count === 0 && row.total_events === 0)) return null;
    // Determine address type: if it appears as contract_address it's a contract, else a wallet
    const address_type: 'contract' | 'wallet' | 'unknown' =
        row.contract_event_count > 0 ? 'contract'
        : row.wallet_event_count > 0 ? 'wallet'
        : 'unknown';
    return { ...row, address_type };
}

export async function getAddressTxs(address: string, limit: number, cursor: number | null): Promise<DbContractEvent[]> {
    const b64  = toBase64Address(address);
    const hex  = toHexAddress(address);
    const lim  = Math.min(limit, 200);
    const params: (string | number | null)[] = [b64, hex, lim];
    const cursorClause = cursor ? `AND id < $${params.push(cursor)}` : '';
    const r = await pool.query<DbContractEvent>(
        `SELECT * FROM contract_events
         WHERE (from_address = $1 OR ($2::text IS NOT NULL AND contract_address = $2))
         ${cursorClause}
         ORDER BY id DESC LIMIT $3`,
        params,
    );
    return r.rows;
}

export async function getAddressTokenActivity(address: string, limit: number): Promise<unknown[]> {
    const b64 = toBase64Address(address);
    const hex = toHexAddress(address);
    const r = await pool.query(
        `SELECT ce.contract_address, t.symbol, t.name, t.decimals,
                COUNT(*)::int AS interaction_count,
                MAX(ce.block_height)::bigint AS last_seen_block
         FROM contract_events ce
         LEFT JOIN tokens t ON t.contract_address = ce.contract_address
         WHERE ce.from_address = $1 OR ($2::text IS NOT NULL AND ce.contract_address = $2)
         GROUP BY ce.contract_address, t.symbol, t.name, t.decimals
         ORDER BY interaction_count DESC LIMIT $3`,
        [b64, hex, Math.min(limit, 100)],
    );
    return r.rows;
}

// ── Analytics ─────────────────────────────────────────────────────────────────
export async function getVolumeAnalytics(contractAddress: string | null): Promise<unknown> {
    const params: (string | null)[] = contractAddress ? [contractAddress] : [];
    const filter = contractAddress ? 'AND contract_address = $1' : '';
    const r = await pool.query(
        `SELECT
            COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '24 hours')::int AS transfers_24h,
            COUNT(*) FILTER (WHERE ts > NOW() - INTERVAL '7 days')::int   AS transfers_7d,
            COALESCE(SUM((decoded->>'amount')::numeric) FILTER (WHERE ts > NOW() - INTERVAL '24 hours'), 0)::text AS volume_24h,
            COALESCE(SUM((decoded->>'amount')::numeric) FILTER (WHERE ts > NOW() - INTERVAL '7 days'), 0)::text   AS volume_7d,
            COUNT(DISTINCT contract_address)::int AS active_tokens_24h
         FROM contract_events
         WHERE event_type = 'Transferred' AND decoded IS NOT NULL ${filter}`,
        params,
    );
    return r.rows[0];
}

export async function getTrendingTokens(limit: number): Promise<unknown[]> {
    const r = await pool.query(
        `SELECT ce.contract_address, t.symbol, t.name,
                COUNT(*)::int AS transfers_24h,
                COUNT(DISTINCT ce.from_address)::int AS unique_senders
         FROM contract_events ce
         LEFT JOIN tokens t ON t.contract_address = ce.contract_address
         WHERE ce.event_type = 'Transferred' AND ce.ts > NOW() - INTERVAL '24 hours'
         GROUP BY ce.contract_address, t.symbol, t.name
         ORDER BY transfers_24h DESC LIMIT $1`,
        [Math.min(limit, 50)],
    );
    return r.rows;
}

export async function globalSearch(query: string): Promise<{ type: string; id: string; description: string; extra?: Record<string, unknown> }[]> {
    const q      = query.trim();
    const qLower = q.toLowerCase();
    const results: { type: string; id: string; description: string; extra?: Record<string, unknown> }[] = [];

    // ── Block number ──────────────────────────────────────────────────────────
    const blockNum = parseInt(q, 10);
    if (Number.isFinite(blockNum) && blockNum > 0 && String(blockNum) === q) {
        const r = await pool.query(
            `SELECT block_height, tx_count, event_count FROM block_activity WHERE block_height = $1`, [blockNum],
        );
        for (const row of r.rows) {
            results.push({ type: 'block', id: String(row.block_height), description: `Block #${row.block_height}`, extra: { txs: row.tx_count, events: row.event_count } });
        }
    }

    // ── TX hash (64-char hex, no 0x prefix) ───────────────────────────────────
    const isTxHash = /^[0-9a-f]{64}$/i.test(q);
    if (isTxHash) {
        const r = await pool.query(
            `SELECT tx_hash, block_height, contract_address FROM contract_events WHERE tx_hash = $1 ORDER BY id ASC LIMIT 1`, [q],
        );
        for (const row of r.rows) {
            results.push({ type: 'tx', id: row.tx_hash, description: `Transaction in block #${row.block_height}`, extra: { contract: row.contract_address } });
        }
    }

    // ── Address / contract (bech32 opt1/bc1* OR legacy 1.../3... OR 0x-hex) ────
    const isBech32    = /^(opt1|bc1|tb1)/i.test(q) && q.length > 10;
    const isLegacyBtc = /^[13][a-zA-Z0-9]{25,34}$/.test(q);
    const is0xHex     = /^0x[0-9a-f]{40,64}$/i.test(q);
    const isAddress   = isBech32 || isLegacyBtc || is0xHex;

    if (isAddress) {
        const hexAddr = is0xHex ? q.toLowerCase() : toHexAddress(q);

        // Check if it's a known token/contract
        if (hexAddr) {
            const r = await pool.query(
                `SELECT contract_address, name, symbol FROM tokens WHERE contract_address = $1`, [hexAddr],
            );
            if (r.rows.length > 0) {
                for (const row of r.rows) {
                    results.push({ type: 'contract', id: row.contract_address, description: row.name ?? row.contract_address, extra: { symbol: row.symbol } });
                }
            } else {
                // Check if it has any events as a contract
                const rc = await pool.query(
                    `SELECT COUNT(*)::int AS cnt FROM contract_events WHERE contract_address = $1 LIMIT 1`, [hexAddr],
                );
                if ((rc.rows[0]?.cnt ?? 0) > 0) {
                    results.push({ type: 'contract', id: hexAddr, description: `Contract ${q.slice(0, 14)}…${q.slice(-6)}` });
                }
            }
        }

        // Check if it has events as a sender (wallet address)
        if (isBech32 || isLegacyBtc) {
            const b64 = toBase64Address(q);
            if (b64) {
                const rw = await pool.query(
                    `SELECT COUNT(DISTINCT tx_hash)::int AS tx_count FROM contract_events WHERE from_address = $1`, [b64],
                );
                if ((rw.rows[0]?.tx_count ?? 0) > 0) {
                    results.push({ type: 'address', id: q, description: `Address ${q.slice(0, 14)}…${q.slice(-6)}`, extra: { txs: rw.rows[0].tx_count } });
                } else if (results.length === 0) {
                    // Show even if no events — let address page handle it
                    results.push({ type: 'address', id: q, description: `Address ${q.slice(0, 14)}…${q.slice(-6)}` });
                }
            } else if (results.length === 0) {
                results.push({ type: 'address', id: q, description: `Address ${q.slice(0, 14)}…${q.slice(-6)}` });
            }
        }
    }

    // ── Token name / symbol fuzzy match ───────────────────────────────────────
    if (q.length >= 2 && !isTxHash && !isAddress) {
        const r = await pool.query(
            `SELECT contract_address, name, symbol FROM tokens
             WHERE (LOWER(symbol) LIKE $1 OR LOWER(name) LIKE $1) AND symbol IS NOT NULL
             ORDER BY CASE WHEN LOWER(symbol) = $2 THEN 0 ELSE 1 END LIMIT 20`,
            [`%${qLower}%`, qLower],
        );
        for (const row of r.rows) {
            results.push({ type: 'token', id: row.contract_address, description: row.name ?? row.contract_address, extra: { symbol: row.symbol } });
        }
    }

    return results;
}

export async function getBetStats(): Promise<unknown> {
    const r = await pool.query(`
        SELECT
            COUNT(*)::int                                    AS total_bets,
            COUNT(*) FILTER (WHERE status = 0)::int          AS active_bets,
            COUNT(*) FILTER (WHERE won = true)::int          AS total_wins,
            COUNT(*) FILTER (WHERE won = false)::int         AS total_losses,
            COALESCE(SUM(payout::numeric) FILTER (WHERE won = true), 0)::text AS total_paid_out
        FROM bets
    `).catch(() => ({ rows: [{ total_bets: 0, active_bets: 0, total_wins: 0, total_losses: 0, total_paid_out: '0' }] }));
    return r.rows[0];
}

// ── API key management ────────────────────────────────────────────────────────
export async function lookupApiKey(keyHash: string): Promise<DbApiKey | null> {
    const r = await pool.query<DbApiKey>(`SELECT * FROM api_keys WHERE key_hash = $1`, [keyHash]);
    return r.rows[0] ?? null;
}

export async function createApiKey(keyHash: string, label: string, rateLimit: number): Promise<DbApiKey> {
    const r = await pool.query<DbApiKey>(
        `INSERT INTO api_keys (key_hash, label, rate_limit) VALUES ($1, $2, $3) RETURNING *`,
        [keyHash, label, rateLimit],
    );
    return r.rows[0]!;
}

export async function listApiKeys(): Promise<DbApiKey[]> {
    const r = await pool.query<DbApiKey>(`SELECT id, label, rate_limit, created_at FROM api_keys ORDER BY created_at DESC`);
    return r.rows;
}

// ── Webhook management ────────────────────────────────────────────────────────
export async function createWebhook(keyId: string, url: string, events: string[], contractFilter: string | null): Promise<DbWebhook> {
    const r = await pool.query<DbWebhook>(
        `INSERT INTO webhooks (key_id, url, events, contract_filter) VALUES ($1, $2, $3, $4) RETURNING *`,
        [keyId, url, events, contractFilter],
    );
    return r.rows[0]!;
}

export async function listWebhooks(keyId: string): Promise<DbWebhook[]> {
    const r = await pool.query<DbWebhook>(`SELECT * FROM webhooks WHERE key_id = $1 ORDER BY created_at DESC`, [keyId]);
    return r.rows;
}

export async function deleteWebhook(keyId: string, id: string): Promise<void> {
    await pool.query(`DELETE FROM webhooks WHERE id = $1 AND key_id = $2`, [id, keyId]);
}

export async function toggleWebhook(keyId: string, id: string, active: boolean): Promise<void> {
    await pool.query(`UPDATE webhooks SET active = $1 WHERE id = $2 AND key_id = $3`, [active, id, keyId]);
}

export async function countWebhooks(keyId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(`SELECT COUNT(*) AS n FROM webhooks WHERE key_id = $1`, [keyId]);
    return Number(r.rows[0]?.n ?? 0);
}

export async function getActiveWebhooks(): Promise<(DbWebhook & { key_id: string; last_event_id: number })[]> {
    const r = await pool.query<DbWebhook & { key_id: string; last_event_id: number }>(
        `SELECT * FROM webhooks WHERE active = true`,
    );
    return r.rows;
}

export async function updateWebhookDelivery(
    id: string, statusCode: number, lastEventId: number,
): Promise<void> {
    await pool.query(
        `UPDATE webhooks
         SET delivery_count   = delivery_count + 1,
             last_delivery_at = NOW(),
             last_status_code = $1,
             last_event_id    = GREATEST(last_event_id, $2)
         WHERE id = $3`,
        [statusCode, lastEventId, id],
    );
}
