/**
 * Fee Worker Thread
 *
 * Polls mempool.space every 5 minutes for Bitcoin fee estimates and mempool size.
 * Writes results into oracle_feeds keyed by current BTC block height.
 */

import { parentPort } from 'worker_threads';
import 'dotenv/config';
import { pool, insertFeedRow } from '../src/db.js';
import type { WorkerMsg } from '../src/types.js';

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const MEMPOOL_BASE     = 'https://mempool.space';

function log(level: 'info' | 'warn' | 'error', message: string): void {
    const msg: WorkerMsg = { type: 'log', level, message };
    parentPort?.postMessage(msg);
}

async function safeFetch(url: string): Promise<Response | null> {
    try {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
        if (!res.ok) { log('warn', `Fee fetch ${url} → HTTP ${res.status}`); return null; }
        return res;
    } catch (err) {
        log('warn', `Fee fetch ${url} failed: ${String(err)}`);
        return null;
    }
}

// Approximate Bitcoin block number from Unix timestamp (genesis Jan 3 2009, ~600s/block)
function approxBtcHeight(): number {
    return Math.floor((Date.now() / 1000 - 1231006505) / 600);
}

async function fetchFees(): Promise<void> {
    const [feesRes, mempoolRes] = await Promise.all([
        safeFetch(`${MEMPOOL_BASE}/api/v1/fees/recommended`),
        safeFetch(`${MEMPOOL_BASE}/api/v1/mempool`),
    ]);

    if (!feesRes || !mempoolRes) return;

    const fees    = await feesRes.json()    as { halfHourFee?: number; hourFee?: number; economyFee?: number };
    const mempool = await mempoolRes.json() as { count?: number };
    const height  = approxBtcHeight();

    const medianFee       = fees.halfHourFee ?? fees.hourFee ?? fees.economyFee ?? 0;
    const medianFeeScaled = Math.round(medianFee * 100);
    const mempoolCount    = mempool.count ?? 0;

    await insertFeedRow(height, medianFeeScaled, mempoolCount);
    log('info', `Fee tick: approx block #${height}  fee=${medianFee} sat/vB  mempool=${mempoolCount} txs`);
}

async function run(): Promise<void> {
    await pool.query('SELECT 1');
    log('info', 'Fee worker started');
    fetchFees().catch(err => log('error', `fetchFees error: ${String(err)}`));
    setInterval(() => fetchFees().catch(err => log('error', `fetchFees error: ${String(err)}`)), POLL_INTERVAL_MS);
}

run().catch(err => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
});
