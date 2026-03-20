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

// Bet activity summary (public, no wallet data)
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
