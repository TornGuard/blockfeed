/**
 * Indexer Worker Thread
 *
 * Polls OPNet RPC for new blocks, stores block_activity and contract_events,
 * and notifies the main thread to broadcast events to WebSocket clients.
 *
 * Runs independently of the HTTP server — crashes here do not crash the API.
 */

import { parentPort } from 'worker_threads';
import 'dotenv/config';
import { pool, ensureSchema, upsertBlockActivity, upsertContractEvent, upsertToken } from '../src/db.js';
import { decodeEvent } from '../src/decoder.js';
import { deliverEvents } from '../src/webhooks.js';
import { fetchAndStoreTokenMetadata } from '../src/token-fetcher.js';
import type { WorkerMsg } from '../src/types.js';

const POLL_INTERVAL_MS = 15_000;
const OPNET_RPC = process.env['OPNET_RPC_URL'] ?? 'https://testnet.opnet.org';

function log(level: 'info' | 'warn' | 'error', message: string): void {
    const msg: WorkerMsg = { type: 'log', level, message };
    parentPort?.postMessage(msg);
}

async function fetchLatestBlock(): Promise<number | null> {
    try {
        const res = await fetch(`${OPNET_RPC}/api/v1/block/latest`, {
            signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return null;
        const json = await res.json();
        // API returns a hex string like "0x2fd1"
        if (typeof json === 'string') return parseInt(json, 16);
        if (typeof json === 'object' && json !== null && 'height' in json) return Number((json as { height: unknown }).height);
        return null;
    } catch {
        return null;
    }
}

interface OPNetEvent {
    contractAddress: string; // 0x-prefixed hex
    type: string;
    data: string; // base64
}

interface OPNetTx {
    hash: string;
    id: string;   // OPNet tx id — this is what OPScan displays
    OPNetType: string;
    contractAddress?: string; // bech32, present on Interaction txs
    from?: string;            // base64 sender
    events?: OPNetEvent[];
}

interface OPNetBlock {
    height: string; // hex
    transactions: OPNetTx[];
    txCount?: number;
}

interface BlockResult {
    events: unknown[];
    txCount: number;
    contractCalls: number;
}

async function fetchBlock(height: number): Promise<BlockResult> {
    try {
        const hexHeight = `0x${height.toString(16)}`;
        const res = await fetch(`${OPNET_RPC}/api/v1/json-rpc`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', method: 'btc_getBlockByNumber', params: [hexHeight, true], id: 1 }),
            signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) return { events: [], txCount: 0, contractCalls: 0 };
        const json = await res.json() as { result?: OPNetBlock };
        const block = json.result;
        if (!block?.transactions) return { events: [], txCount: 0, contractCalls: 0 };

        const events: unknown[] = [];
        let contractCalls = 0;
        for (const tx of block.transactions) {
            if (tx.OPNetType === 'Interaction') contractCalls++;
            if (!tx.events?.length) continue;
            for (const ev of tx.events) {
                events.push({
                    txHash:          tx.id ?? tx.hash,
                    contractAddress: ev.contractAddress,
                    eventType:       ev.type,
                    fromAddress:     tx.from ?? null,
                    data:            ev.data,
                });
            }
        }
        return { events, txCount: block.transactions.length, contractCalls };
    } catch {
        return { events: [], txCount: 0, contractCalls: 0 };
    }
}

let lastIndexedHeight = 0;

async function tick(): Promise<void> {
    const latest = await fetchLatestBlock();
    if (!latest || latest <= lastIndexedHeight) return;

    for (let h = lastIndexedHeight + 1; h <= latest; h++) {
        const { events: rawEvents, txCount, contractCalls } = await fetchBlock(h);
        const insertedEvents: unknown[] = [];
        const newContracts = new Set<string>();

        await upsertBlockActivity(h, rawEvents.length, txCount, contractCalls);

        for (const raw of rawEvents) {
            const ev = raw as {
                txHash?: string;
                contractAddress?: string;
                eventType?: string;
                fromAddress?: string;
                data?: string;
            };

            if (!ev.txHash || !ev.contractAddress || !ev.eventType) continue;

            const decoded = decodeEvent(ev.eventType, ev.data ?? '');
            const row = await upsertContractEvent({
                blockHeight:     h,
                txHash:          ev.txHash,
                contractAddress: ev.contractAddress,
                eventType:       ev.eventType,
                fromAddress:     ev.fromAddress ?? null,
                decoded:         decoded,
            });

            if (row) {
                newContracts.add(ev.contractAddress);
                insertedEvents.push(row);

                // Broadcast to WebSocket subscribers via main thread
                const msg: WorkerMsg = { type: 'broadcast', event: 'event', data: row };
                parentPort?.postMessage(msg);
            }
        }

        // Fire webhooks
        if (insertedEvents.length > 0) {
            deliverEvents(insertedEvents as Record<string, unknown>[]);
        }

        // Fetch token metadata for new contracts (non-blocking)
        for (const addr of newContracts) {
            upsertToken(addr);
            fetchAndStoreTokenMetadata(addr).catch(() => undefined);
        }

        // Notify main thread to broadcast new block to WebSocket clients
        const blockMsg: WorkerMsg = {
            type: 'broadcast',
            event: 'block_update',
            data: { block_height: h, event_count: insertedEvents.length, mempool_count: 0, median_fee_scaled: 0, submitted_at: new Date() },
        };
        parentPort?.postMessage(blockMsg);

        log('info', `Indexed block #${h} — ${insertedEvents.length} events`);
    }

    lastIndexedHeight = latest;
}

async function run(): Promise<void> {
    await pool.query('SELECT 1');
    await ensureSchema();

    // Seed from DB so we don't re-index blocks already stored
    const { rows } = await pool.query<{ max: string | null }>('SELECT MAX(block_height) AS max FROM block_activity');
    if (rows[0]?.max != null) {
        lastIndexedHeight = Number(rows[0].max);
        log('info', `Resuming from block #${lastIndexedHeight}`);
    }

    log('info', 'Indexer worker started');

    // Run immediately then on interval
    tick().catch(err => log('error', `tick error: ${String(err)}`));
    setInterval(() => {
        tick().catch(err => log('error', `tick error: ${String(err)}`));
    }, POLL_INTERVAL_MS);
}

run().catch(err => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
});
