/**
 * Prometheus metrics for BlockFeed.
 * Exposed at GET /metrics (text/plain Prometheus exposition format).
 */

import type HyperExpress from '@btc-vision/hyper-express';
import { pool } from './db.js';

interface Counters {
    http_requests_total:      number;
    http_errors_total:        number;
    ws_connections_total:     number;
    ws_messages_sent_total:   number;
    oracle_ticks_total:       number;
    oracle_errors_total:      number;
    webhook_deliveries_total: number;
    webhook_failures_total:   number;
    rpc_proxy_requests_total: number;
}

const counters: Counters = {
    http_requests_total:      0,
    http_errors_total:        0,
    ws_connections_total:     0,
    ws_messages_sent_total:   0,
    oracle_ticks_total:       0,
    oracle_errors_total:      0,
    webhook_deliveries_total: 0,
    webhook_failures_total:   0,
    rpc_proxy_requests_total: 0,
};

const routeCounters = new Map<string, number>();

const gauges: Record<string, number> = {
    ws_connected_clients:   0,
    process_uptime_seconds: 0,
};

export function incCounter(name: keyof Counters, labels?: { route?: string }): void {
    if (name in counters) counters[name]++;
    if (name === 'http_requests_total' && labels?.route) {
        const key = labels.route;
        routeCounters.set(key, (routeCounters.get(key) ?? 0) + 1);
    }
}

export function setGauge(name: string, value: number): void {
    gauges[name] = value;
}

function fmtCounter(name: string, help: string, value: number): string {
    return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

function fmtGauge(name: string, help: string, value: number): string {
    return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

function fmtLabeledCounter(name: string, help: string, entries: [string, number][]): string {
    const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
    for (const [labels, val] of entries) lines.push(`${name}{${labels}} ${val}`);
    return lines.join('\n') + '\n';
}

async function fetchDbGauges(): Promise<Record<string, number>> {
    try {
        const [blocks, events, tokens, keys, hooks, symbols] = await Promise.all([
            pool.query('SELECT COUNT(*) AS n FROM block_activity').catch(() => ({ rows: [{ n: 0 }] })),
            pool.query('SELECT COUNT(*) AS n FROM contract_events').catch(() => ({ rows: [{ n: 0 }] })),
            pool.query("SELECT COUNT(*) AS n FROM tokens WHERE symbol IS NOT NULL").catch(() => ({ rows: [{ n: 0 }] })),
            pool.query('SELECT COUNT(*) AS n FROM api_keys').catch(() => ({ rows: [{ n: 0 }] })),
            pool.query('SELECT COUNT(*) AS n FROM webhooks WHERE active = true').catch(() => ({ rows: [{ n: 0 }] })),
            pool.query('SELECT COUNT(DISTINCT symbol) AS n FROM oracle_prices').catch(() => ({ rows: [{ n: 0 }] })),
        ]);
        return {
            blocks_indexed:    Number(blocks.rows[0]?.n ?? 0),
            events_indexed:    Number(events.rows[0]?.n ?? 0),
            tokens_tracked:    Number(tokens.rows[0]?.n ?? 0),
            api_keys_active:   Number(keys.rows[0]?.n ?? 0),
            webhooks_active:   Number(hooks.rows[0]?.n ?? 0),
            oracle_symbols:    Number(symbols.rows[0]?.n ?? 0),
        };
    } catch { return {}; }
}

export async function handleMetrics(res: HyperExpress.Response): Promise<void> {
    gauges['process_uptime_seconds'] = Math.floor(process.uptime());
    const db = await fetchDbGauges();

    const out = [
        fmtCounter('blockfeed_http_requests_total',      'Total HTTP requests',         counters.http_requests_total),
        fmtCounter('blockfeed_http_errors_total',         'Total HTTP 5xx errors',       counters.http_errors_total),
        fmtCounter('blockfeed_ws_connections_total',      'Total WebSocket connections', counters.ws_connections_total),
        fmtCounter('blockfeed_ws_messages_sent_total',    'Total WS messages sent',      counters.ws_messages_sent_total),
        fmtCounter('blockfeed_oracle_ticks_total',        'Total oracle price ticks',    counters.oracle_ticks_total),
        fmtCounter('blockfeed_oracle_errors_total',       'Total oracle tick errors',    counters.oracle_errors_total),
        fmtCounter('blockfeed_webhook_deliveries_total',  'Total webhook deliveries',    counters.webhook_deliveries_total),
        fmtCounter('blockfeed_webhook_failures_total',    'Total webhook failures',      counters.webhook_failures_total),
        fmtCounter('blockfeed_rpc_proxy_requests_total',  'Total RPC proxy requests',    counters.rpc_proxy_requests_total),

        fmtGauge('blockfeed_ws_connected_clients',   'Current WS connections',       gauges['ws_connected_clients'] ?? 0),
        fmtGauge('blockfeed_process_uptime_seconds', 'Process uptime seconds',       gauges['process_uptime_seconds'] ?? 0),
        fmtGauge('blockfeed_blocks_indexed_total',   'Total blocks indexed',         db['blocks_indexed'] ?? 0),
        fmtGauge('blockfeed_events_indexed_total',   'Total contract events',        db['events_indexed'] ?? 0),
        fmtGauge('blockfeed_tokens_tracked_total',   'Total tokens with metadata',   db['tokens_tracked'] ?? 0),
        fmtGauge('blockfeed_api_keys_active',        'Total active API keys',        db['api_keys_active'] ?? 0),
        fmtGauge('blockfeed_webhooks_active',        'Total active webhooks',        db['webhooks_active'] ?? 0),
        fmtGauge('blockfeed_oracle_symbols_tracked', 'Oracle symbols tracked',       db['oracle_symbols'] ?? 0),

        fmtLabeledCounter(
            'blockfeed_http_requests_by_route',
            'Requests by route',
            [...routeCounters.entries()].map(([route, n]) => [`route="${route}"`, n] as [string, number]),
        ),
    ].join('');

    res.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(out);
}
