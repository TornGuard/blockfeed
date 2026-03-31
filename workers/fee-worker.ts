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

async function fetchFees(): Promise<void> {
    log('info', 'Fee tick starting…');
    const [feesRes, mempoolRes, blockRes] = await Promise.all([
        safeFetch(`${MEMPOOL_BASE}/api/v1/fees/recommended`),
        safeFetch(`${MEMPOOL_BASE}/api/v1/mempool`),
        safeFetch(`${MEMPOOL_BASE}/api/blocks/tip/height`),
    ]);

    if (!feesRes || !mempoolRes || !blockRes) return;

    const fees    = await feesRes.json()    as { halfHourFee?: number; hourFee?: number; economyFee?: number };
    const mempool = await mempoolRes.json() as { count?: number };
    const height  = Number(await blockRes.text());

    log('info', `Fee data: height=${height} fees=${JSON.stringify(fees)} mempoolCount=${mempool.count}`);

    if (!height || isNaN(height)) { log('warn', `Invalid block height: ${height}`); return; }

    const medianFee       = fees.halfHourFee ?? fees.hourFee ?? fees.economyFee ?? 0;
    const medianFeeScaled = Math.round(medianFee * 100);
    const mempoolCount    = mempool.count ?? 0;

    await insertFeedRow(height, medianFeeScaled, mempoolCount);
    log('info', `Fee tick done: block #${height}  fee=${medianFee} sat/vB  mempool=${mempoolCount} txs`);
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
