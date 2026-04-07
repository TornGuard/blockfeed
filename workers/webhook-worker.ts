/**
 * Webhook Delivery Worker
 *
 * Polls for new contract_events and delivers them to registered webhook URLs.
 * - HMAC-SHA256 signed payloads (X-BlockFeed-Signature header)
 * - Idempotency key per delivery (X-BlockFeed-Delivery)
 * - Up to 3 retries with exponential backoff
 * - Per-webhook event cursor (last_event_id) to never replay
 */

import { parentPort } from 'worker_threads';
import pg from 'pg';
import crypto from 'crypto';

const { Pool } = pg;

const pool = new Pool({
    connectionString: process.env['DATABASE_URL'],
    ssl:              { rejectUnauthorized: false },
    max:              5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 20_000,
});

const POLL_INTERVAL_MS  = 5_000;   // Check for new events every 5s
const MAX_RETRIES       = 3;
const RETRY_DELAYS      = [1_000, 5_000, 15_000]; // backoff per attempt
const DELIVERY_TIMEOUT  = 10_000;  // 10s per HTTP call
const BATCH_SIZE        = 50;      // events to fetch per webhook per tick
const WEBHOOK_SECRET    = process.env['WEBHOOK_SECRET'] ?? 'blockfeed-secret';

function log(msg: string, level: 'info' | 'warn' | 'error' = 'info'): void {
    parentPort?.postMessage({ type: 'log', level, message: msg });
}

// ── HMAC signature ─────────────────────────────────────────────────────────────
function sign(body: string, secret: string): string {
    return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

// ── HTTP delivery with retries ─────────────────────────────────────────────────
async function deliver(
    url: string,
    payload: object,
    deliveryId: string,
): Promise<{ status: number; ok: boolean }> {
    const body = JSON.stringify(payload);
    const sig  = sign(body, WEBHOOK_SECRET);

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt - 1]));
            log(`Retry ${attempt}/${MAX_RETRIES - 1} for ${url}`, 'warn');
        }

        try {
            const ctrl = new AbortController();
            const timeout = setTimeout(() => ctrl.abort(), DELIVERY_TIMEOUT);

            const res = await fetch(url, {
                method:  'POST',
                headers: {
                    'Content-Type':          'application/json',
                    'X-BlockFeed-Signature': sig,
                    'X-BlockFeed-Delivery':  deliveryId,
                    'User-Agent':            'BlockFeed-Webhooks/1.0',
                },
                body,
                signal: ctrl.signal,
            });

            clearTimeout(timeout);

            if (res.ok || res.status < 500) {
                // 2xx or 4xx — don't retry 4xx (client error)
                return { status: res.status, ok: res.ok };
            }
            // 5xx — retry
        } catch (err) {
            log(`Delivery error for ${url}: ${(err as Error).message}`, 'warn');
        }
    }

    return { status: 0, ok: false }; // all retries exhausted
}

// ── Main poll loop ─────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
    // Load active webhooks
    const hookRes = await pool.query<{
        id: string; url: string; events: string[];
        contract_filter: string | null; last_event_id: number;
    }>(`SELECT id, url, events, contract_filter, last_event_id FROM webhooks WHERE active = true`);

    if (!hookRes.rows.length) return;

    for (const hook of hookRes.rows) {
        try {
            await processHook(hook);
        } catch (err) {
            log(`Hook ${hook.id} error: ${(err as Error).message}`, 'error');
        }
    }
}

async function processHook(hook: {
    id: string; url: string; events: string[];
    contract_filter: string | null; last_event_id: number;
}): Promise<void> {
    // Build query for events after cursor
    const params: (number | string | string[] | null)[] = [hook.last_event_id, BATCH_SIZE];
    let whereClause = `id > $1`;

    if (hook.events.length > 0) {
        whereClause += ` AND event_type = ANY($${params.push(hook.events)})`;
    }
    if (hook.contract_filter) {
        whereClause += ` AND contract_address = $${params.push(hook.contract_filter)}`;
    }

    const evRes = await pool.query<{
        id: number; block_height: number; tx_hash: string;
        contract_address: string; event_type: string;
        from_address: string | null; decoded: unknown; ts: Date;
    }>(
        `SELECT id, block_height, tx_hash, contract_address, event_type, from_address, decoded, ts
         FROM contract_events WHERE ${whereClause} ORDER BY id ASC LIMIT $2`,
        params,
    );

    if (!evRes.rows.length) return;

    let lastDeliveredId = hook.last_event_id;
    let lastStatus      = 200;

    for (const ev of evRes.rows) {
        const deliveryId = `${hook.id}-${ev.id}`;
        const payload = {
            delivery_id: deliveryId,
            event:       ev.event_type,
            block:       ev.block_height,
            tx:          ev.tx_hash,
            contract:    ev.contract_address,
            from:        ev.from_address,
            data:        ev.decoded,
            ts:          ev.ts,
        };

        const { status } = await deliver(hook.url, payload, deliveryId);
        lastStatus = status;

        if (status > 0) {
            // Successfully sent (even if 4xx — we move cursor forward to avoid replay)
            lastDeliveredId = ev.id;
        } else {
            // All retries failed — stop processing this hook for now, update cursor
            log(`Hook ${hook.id}: all retries exhausted for event ${ev.id}, will retry next tick`, 'warn');
            break;
        }
    }

    // Update cursor + stats
    await pool.query(
        `UPDATE webhooks
         SET delivery_count   = delivery_count + 1,
             last_delivery_at = NOW(),
             last_status_code = $1,
             last_event_id    = GREATEST(last_event_id, $2)
         WHERE id = $3`,
        [lastStatus, lastDeliveredId, hook.id],
    );

    if (lastDeliveredId > hook.last_event_id) {
        const count = evRes.rows.filter(e => e.id <= lastDeliveredId).length;
        log(`Hook ${hook.id}: delivered ${count} event(s) to ${hook.url} (status ${lastStatus})`);
    }
}

// ── Bootstrap ──────────────────────────────────────────────────────────────────
async function run(): Promise<void> {
    await pool.query('SELECT 1');
    log('Webhook worker started');

    const loop = async () => {
        try { await tick(); } catch (err) {
            log(`Tick error: ${(err as Error).message}`, 'error');
        }
        setTimeout(loop, POLL_INTERVAL_MS);
    };

    // Stagger start to avoid thundering herd with other workers
    setTimeout(loop, 3_000);
}

run().catch(err => {
    log(`Fatal: ${(err as Error).message}`, 'error');
    process.exit(1);
});
