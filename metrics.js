/**
 * Prometheus metrics for BlockFeed.
 *
 * Exposes GET /metrics in text/plain Prometheus exposition format.
 *
 * Counters increment in-process. Gauges are refreshed from DB on scrape.
 * This keeps the hot path (every REST request) allocation-free — only the
 * scrape endpoint queries the DB.
 *
 * Typical Prometheus scrape config:
 *   - job_name: 'blockfeed'
 *     static_configs:
 *       - targets: ['localhost:3001']
 *     metrics_path: /metrics
 *     scrape_interval: 15s
 */

import { pool } from './db.js';

// ── In-process counters ───────────────────────────────────────────────────────
const counters = {
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

// ── Per-route request counts ──────────────────────────────────────────────────
const routeCounters = new Map();

// ── In-process gauges (updated by internal code) ──────────────────────────────
const gauges = {
  ws_connected_clients:     0,
  process_uptime_seconds:   0,
};

export function incCounter(name, labels = null) {
  if (name in counters) counters[name]++;

  if (name === 'http_requests_total' && labels?.route) {
    const key = labels.route;
    routeCounters.set(key, (routeCounters.get(key) ?? 0) + 1);
  }
}

export function setGauge(name, value) {
  gauges[name] = value;
}

// ── Prometheus text format helpers ────────────────────────────────────────────
function counter(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} counter\n${name} ${value}\n`;
}

function gauge(name, help, value) {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}

function labeledCounter(name, help, entries) {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} counter`];
  for (const [labels, val] of entries) {
    lines.push(`${name}{${labels}} ${val}`);
  }
  return lines.join('\n') + '\n';
}

// ── DB gauge queries (run only on scrape) ─────────────────────────────────────
async function fetchDbGauges() {
  try {
    const [blocks, events, tokens, keys, hooks, oracle] = await Promise.all([
      pool.query('SELECT COUNT(*) AS n FROM block_activity').catch(() => ({ rows: [{ n: 0 }] })),
      pool.query('SELECT COUNT(*) AS n FROM contract_events').catch(() => ({ rows: [{ n: 0 }] })),
      pool.query("SELECT COUNT(*) AS n FROM tokens WHERE symbol IS NOT NULL").catch(() => ({ rows: [{ n: 0 }] })),
      pool.query('SELECT COUNT(*) AS n FROM api_keys').catch(() => ({ rows: [{ n: 0 }] })),
      pool.query('SELECT COUNT(*) AS n FROM webhooks WHERE active = true').catch(() => ({ rows: [{ n: 0 }] })),
      pool.query('SELECT COUNT(DISTINCT symbol) AS n FROM oracle_prices').catch(() => ({ rows: [{ n: 0 }] })),
    ]);

    return {
      blocks_indexed:     Number(blocks.rows[0].n),
      events_indexed:     Number(events.rows[0].n),
      tokens_tracked:     Number(tokens.rows[0].n),
      api_keys_active:    Number(keys.rows[0].n),
      webhooks_active:    Number(hooks.rows[0].n),
      oracle_symbols:     Number(oracle.rows[0].n),
    };
  } catch {
    return {};
  }
}

// ── Scrape handler ────────────────────────────────────────────────────────────
export async function handleMetrics(res) {
  gauges.process_uptime_seconds = Math.floor(process.uptime());

  const db = await fetchDbGauges();

  const lines = [
    counter('blockfeed_http_requests_total',      'Total HTTP requests handled', counters.http_requests_total),
    counter('blockfeed_http_errors_total',         'Total HTTP 5xx errors',       counters.http_errors_total),
    counter('blockfeed_ws_connections_total',      'Total WebSocket connections',  counters.ws_connections_total),
    counter('blockfeed_ws_messages_sent_total',    'Total WebSocket messages sent',counters.ws_messages_sent_total),
    counter('blockfeed_oracle_ticks_total',        'Total oracle price ticks',     counters.oracle_ticks_total),
    counter('blockfeed_oracle_errors_total',       'Total oracle tick errors',     counters.oracle_errors_total),
    counter('blockfeed_webhook_deliveries_total',  'Total webhook POST attempts',  counters.webhook_deliveries_total),
    counter('blockfeed_webhook_failures_total',    'Total webhook delivery failures', counters.webhook_failures_total),
    counter('blockfeed_rpc_proxy_requests_total',  'Total RPC proxy calls',        counters.rpc_proxy_requests_total),

    gauge('blockfeed_ws_connected_clients',    'Current WebSocket connections',         gauges.ws_connected_clients),
    gauge('blockfeed_process_uptime_seconds',  'Process uptime in seconds',             gauges.process_uptime_seconds),
    gauge('blockfeed_blocks_indexed_total',    'Total Bitcoin/OPNet blocks indexed',    db.blocks_indexed ?? 0),
    gauge('blockfeed_events_indexed_total',    'Total contract events indexed',         db.events_indexed ?? 0),
    gauge('blockfeed_tokens_tracked_total',    'Total OP20 tokens with metadata',       db.tokens_tracked ?? 0),
    gauge('blockfeed_api_keys_active',         'Total active API keys',                 db.api_keys_active ?? 0),
    gauge('blockfeed_webhooks_active',         'Total active webhooks',                 db.webhooks_active ?? 0),
    gauge('blockfeed_oracle_symbols_tracked',  'Number of symbols tracked by oracle',   db.oracle_symbols ?? 0),

    // Per-route breakdown
    labeledCounter(
      'blockfeed_http_requests_by_route',
      'HTTP requests broken down by route',
      [...routeCounters.entries()].map(([route, n]) => [`route="${route}"`, n]),
    ),
  ];

  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(lines.join(''));
}
