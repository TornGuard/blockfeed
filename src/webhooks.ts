/**
 * Webhook delivery — fire-and-forget HTTP POST to subscriber URLs.
 *
 * On each delivery attempt:
 *   - POST JSON to the subscriber's URL with a 5s timeout
 *   - Retry once on failure after 5 seconds
 *   - Record last_status_code in DB
 *   - Never block the indexer — errors are swallowed after max retries
 */

import { pool } from './db.js';
import { incCounter } from './metrics.js';

const DELIVERY_TIMEOUT_MS = 5_000;
const MAX_RETRIES         = 2;

interface DbWebhookRow {
    id: string;
    url: string;
    events: string[];
    contract_filter: string | null;
}

async function doPost(url: string, payload: string, attempt: number): Promise<boolean> {
    try {
        const res = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'BlockFeed-Webhook/1.0' },
            body:    payload,
            signal:  AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
        });
        incCounter('webhook_deliveries_total');
        return res.ok;
    } catch {
        if (attempt < MAX_RETRIES - 1) {
            await new Promise<void>(r => setTimeout(r, 5_000));
            return doPost(url, payload, attempt + 1);
        }
        incCounter('webhook_failures_total');
        return false;
    }
}

export async function deliverEvents(events: Record<string, unknown>[]): Promise<void> {
    if (events.length === 0) return;

    let hooks: DbWebhookRow[];
    try {
        const result = await pool.query<DbWebhookRow>(
            `SELECT id, url, events, contract_filter FROM webhooks WHERE active = true`,
        );
        hooks = result.rows;
    } catch { return; }

    for (const hook of hooks) {
        const matching = events.filter(ev => {
            if (!hook.events.includes(ev['event_type'] as string) &&
                !hook.events.includes('*')) return false;
            if (hook.contract_filter && ev['contract_address'] !== hook.contract_filter) return false;
            return true;
        });

        if (matching.length === 0) continue;

        const payload = JSON.stringify({ events: matching });
        doPost(hook.url, payload, 0).then(ok => {
            pool.query(
                `UPDATE webhooks SET delivery_count = delivery_count + 1, last_delivery_at = NOW(), last_status_code = $1 WHERE id = $2`,
                [ok ? 200 : 0, hook.id],
            ).catch(() => undefined);
        }).catch(() => undefined);
    }
}
