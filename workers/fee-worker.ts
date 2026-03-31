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

async function fetchFees(): Promise<void> {
    try {
        const [feesRes, mempoolRes, blockRes] = await Promise.all([
            fetch(`${MEMPOOL_BASE}/api/v1/fees/recommended`, { signal: AbortSignal.timeout(8_000) }),
            fetch(`${MEMPOOL_BASE}/api/v1/mempool`,          { signal: AbortSignal.timeout(8_000) }),
            fetch(`${MEMPOOL_BASE}/api/blocks/tip/height`,   { signal: AbortSignal.timeout(8_000) }),
        ]);

        if (!feesRes.ok || !mempoolRes.ok || !blockRes.ok) return;

        const fees    = await feesRes.json()    as { halfHourFee?: number; hourFee?: number; economyFee?: number };
        const mempool = await mempoolRes.json() as { count?: number };
        const height  = Number(await blockRes.text());

        if (!height || isNaN(height)) return;

        // Use halfHourFee as median estimate; scale by 100 to store as integer
        const medianFee = fees.halfHourFee ?? fees.hourFee ?? fees.economyFee ?? 0;
        const medianFeeScaled = Math.round(medianFee * 100);
        const mempoolCount    = mempool.count ?? 0;

        await insertFeedRow(height, medianFeeScaled, mempoolCount);
        log('info', `Fee tick: block #${height}  fee=${medianFee} sat/vB  mempool=${mempoolCount} txs`);
    } catch (err) {
        log('warn', `Fee fetch failed: ${String(err)}`);
    }
}

async function run(): Promise<void> {
    await pool.query('SELECT 1');
    log('info', 'Fee worker started');
    fetchFees().catch(() => undefined);
    setInterval(() => fetchFees().catch(() => undefined), POLL_INTERVAL_MS);
}

run().catch(err => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
});
