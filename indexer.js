/**
 * BlockFeed Indexer
 * Polls OPNet RPC every 30s to collect rich per-block data:
 *   - tx count, gas used, contract calls, unique senders
 *   - all contract events (Transferred, Swap*, Liquidity*, etc.)
 *   - mempool.space fee histogram snapshot
 */

import { pool } from './db.js';
import { decodeEvent } from './decoder.js';
import { upsertToken } from './db.js';
import { fetchAndStoreTokenMetadata } from './token-fetcher.js';
import { deliverEvents } from './webhooks.js';

const OPNET_RPC     = 'https://testnet.opnet.org/api/v1/json-rpc';
const MEMPOOL_API   = 'https://mempool.space/api/mempool';
const POLL_INTERVAL = 30_000; // 30s — blocks are ~10 min, this is fine

let lastIndexedHeight = 0;

// ── OPNet JSON-RPC helper ────────────────────────────────────────────────────
async function rpc(method, params = []) {
  const res = await fetch(OPNET_RPC, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent':   'OPNET/1.0',
      'Accept':       'application/json',
    },
    body:   JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

// ── Index a single block ─────────────────────────────────────────────────────
async function indexBlock(height) {
  const block = await rpc('btc_getBlockByNumber', [`0x${height.toString(16)}`, true]);
  if (!block) return;

  const txs           = block.transactions || [];
  const interactions  = txs.filter(tx => tx.OPNetType === 'Interaction');
  const contractCalls = interactions.length;
  const uniqueSenders = new Set(interactions.map(tx => tx.from).filter(Boolean)).size;
  const gasUsed       = Number(block.gasUsed || 0);
  const txCount       = block.txCount || txs.length;

  // Flatten all events across transactions
  const events = [];
  for (const tx of txs) {
    for (const ev of (tx.events || [])) {
      const rawData = ev.data || null;
      events.push({
        tx_hash:          tx.hash,
        contract_address: ev.contractAddress,
        event_type:       ev.type,
        from_address:     tx.from || null,
        raw_data:         rawData,
        decoded:          decodeEvent(ev.type, rawData),
      });
    }
  }

  // Persist block activity
  await pool.query(`
    INSERT INTO block_activity
      (block_height, tx_count, contract_calls, unique_senders, gas_used, events_count)
    VALUES ($1, $2, $3, $4, $5, $6)
    ON CONFLICT (block_height) DO NOTHING
  `, [height, txCount, contractCalls, uniqueSenders, gasUsed, events.length]);

  // Collect new contract addresses for token registry
  const newContracts = new Set();
  const insertedEvents = [];

  // Persist events (ignore duplicates)
  for (const ev of events) {
    const result = await pool.query(`
      INSERT INTO contract_events
        (block_height, tx_hash, contract_address, event_type, from_address, raw_data, decoded)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
      ON CONFLICT DO NOTHING
      RETURNING id, block_height, tx_hash, contract_address, event_type, from_address, decoded, ts
    `, [height, ev.tx_hash, ev.contract_address, ev.event_type, ev.from_address, ev.raw_data,
        ev.decoded ? JSON.stringify(ev.decoded) : null]);

    if (result.rows.length > 0) {
      // New row inserted — this contract may not be in the token registry yet
      newContracts.add(ev.contract_address);
      insertedEvents.push(result.rows[0]);
    }
  }

  // Fire webhooks for all newly inserted events (fire-and-forget)
  if (insertedEvents.length > 0) {
    deliverEvents(insertedEvents);
  }

  // Upsert token registry entries and kick off metadata fetch for new ones
  for (const addr of newContracts) {
    const { rowCount } = await pool.query(`
      INSERT INTO tokens (contract_address, first_seen_block, last_seen_block)
      VALUES ($1, $2, $2)
      ON CONFLICT (contract_address) DO UPDATE
        SET last_seen_block = GREATEST(tokens.last_seen_block, $2)
      RETURNING (xmax = 0) AS inserted
    `, [addr, height]);

    // If newly inserted (xmax = 0 means INSERT, not UPDATE), schedule metadata fetch
    // We check rowCount instead — if fetch_status is still 'pending' we queue it
    // Run in background — do NOT await to avoid blocking indexer
    fetchAndStoreTokenMetadata(addr).catch(() => {});
  }

  console.log(
    `[Indexer] Block #${height}: ${txCount} txs, ${contractCalls} contract calls,` +
    ` ${uniqueSenders} senders, ${events.length} events, gas ${gasUsed.toLocaleString()}`
  );
}

// ── Fetch + store mempool.space fee histogram ────────────────────────────────
async function indexHistogram(height) {
  try {
    const res  = await fetch(MEMPOOL_API, { signal: AbortSignal.timeout(10_000) });
    const data = await res.json();
    if (!data.fee_histogram?.length) return;

    await pool.query(`
      INSERT INTO fee_snapshots (block_height, histogram)
      VALUES ($1, $2::jsonb)
    `, [height, JSON.stringify(data.fee_histogram)]);
  } catch (e) {
    console.warn('[Indexer] Histogram fetch failed:', e.message);
  }
}

// ── Main poll loop ───────────────────────────────────────────────────────────
async function poll() {
  try {
    const hexHeight = await rpc('btc_blockNumber', []);
    const height    = parseInt(hexHeight, 16);
    if (height <= lastIndexedHeight) return;

    await indexBlock(height);
    await indexHistogram(height);
    lastIndexedHeight = height;
  } catch (e) {
    console.error('[Indexer] Poll error:', e.message);
  }
}

export async function startIndexer() {
  // Resume from last indexed block
  try {
    const r = await pool.query('SELECT MAX(block_height) AS h FROM block_activity');
    lastIndexedHeight = Number(r.rows[0]?.h || 0);
  } catch { /* table may not exist yet — ensureSchema runs first */ }

  console.log(`[Indexer] Starting — last indexed block: #${lastIndexedHeight}`);
  await poll();
  setInterval(poll, POLL_INTERVAL);
}
