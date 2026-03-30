/**
 * BlockFeed REST routes — registered on the HyperExpress server.
 *
 * Replaces the manual if/else URL matching in the old routes.js.
 * Each handler is fully typed; no `any`.
 */

import HyperExpress from '@btc-vision/hyper-express';
import crypto from 'crypto';
import {
    getLatestFee, getFeeHistory, getFeeStats,
    getBlockActivity, getLatestBlockActivity, getActivityStats, getLatestHistogram,
    getRecentEvents, getTopContracts, getEventTypeSummary,
    getToken, getTokens, getContractEvents, getContractStats,
    getLatestOraclePrice, getOraclePriceHistory, getAllLatestOraclePrices,
    getBetStats,
    createApiKey, listApiKeys,
    createWebhook, listWebhooks, deleteWebhook, toggleWebhook, countWebhooks,
    getAddressOverview, getAddressTxs, getAddressTokenActivity,
    getTxByHash, getTokenHolders, getOhlcv,
    getVolumeAnalytics, getTrendingTokens, globalSearch,
} from './db.js';
import { getOraclePubKey } from './oracle.js';
import { getConnectedClients } from './feed.js';
import { handleMetrics, incCounter } from './metrics.js';
import { handleRpcProxy } from './rpc-proxy.js';
import { verifyApiKey, isAdminRequest, rateLimitCheck } from './middleware.js';
import { handleGraphQL } from './graphql.js';

type Req  = HyperExpress.Request;
type Res  = HyperExpress.Response;

function lim(req: Req, def: number, max: number): number {
    const v = parseInt(req.query_parameters['limit'] ?? String(def), 10);
    return Math.min(isNaN(v) || v < 1 ? def : v, max);
}

function cur(req: Req): number | null {
    const v = parseInt(req.query_parameters['cursor'] ?? '', 10);
    return isNaN(v) ? null : v;
}

/** Auth gate — checks API key + rate limit. Sends 401/429 and returns false on failure. */
async function auth(req: Req, res: Res): Promise<boolean> {
    const ok = await rateLimitCheck(req, res);
    return ok;
}

export function registerRoutes(app: HyperExpress.Server): void {

    // ── Status ────────────────────────────────────────────────────────────────
    app.get('/', (_req, res) => {
        res.json({
            service: 'BlockFeed', version: '1.0.0',
            endpoints: [
                'GET  /v1/status',
                'GET  /v1/fees/latest | /history | /stats',
                'GET  /v1/mempool/depth | /histogram',
                'GET  /v1/blocks/latest | /activity | /activity/latest | /activity/stats',
                'GET  /v1/events/recent | /types',
                'GET  /v1/contracts/top | /:address/events | /:address/stats',
                'GET  /v1/tokens | /:address | /:address/transfers | /:address/holders',
                'GET  /v1/address/:address | /:address/txs | /:address/tokens',
                'GET  /v1/tx/:hash',
                'GET  /v1/oracle/all | /btc | /:symbol | /:symbol/ohlcv | /:symbol/history',
                'GET  /v1/analytics/volume | /trending',
                'GET  /v1/search?q=',
                'GET  /v1/bets/stats',
                'POST /v1/rpc',
                'WS   /v1/stream',
                'POST /graphql',
                'GET  /metrics',
            ],
        });
    });

    app.get('/v1/status', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/status' });
        const latest = await getLatestFee();
        res.json({
            ok: true,
            latest_block: latest?.block_height ?? null,
            ws_clients: getConnectedClients(),
            uptime: Math.floor(process.uptime()),
        });
    });

    // ── Fees ──────────────────────────────────────────────────────────────────
    app.get('/v1/fees/latest', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/fees/latest' });
        const row = await getLatestFee();
        if (!row) { res.status(404).json({ error: 'No data' }); return; }
        res.json({ ok: true, data: row });
    });

    app.get('/v1/fees/history', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/fees/history' });
        const rows = await getFeeHistory(lim(req, 50, 500));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/fees/stats', async (req, res) => {
        if (!await auth(req, res)) return;
        res.json({ ok: true, data: await getFeeStats() });
    });

    // ── Mempool ───────────────────────────────────────────────────────────────
    app.get('/v1/mempool/depth', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/mempool/depth' });
        const row = await getLatestFee();
        res.json({ ok: true, data: { mempool_count: row?.mempool_count ?? null } });
    });

    app.get('/v1/mempool/histogram', async (req, res) => {
        if (!await auth(req, res)) return;
        const rows = await getLatestHistogram();
        res.json({ ok: true, data: rows });
    });

    // ── Blocks ────────────────────────────────────────────────────────────────
    app.get('/v1/blocks/latest', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/blocks/latest' });
        const row = await getLatestBlockActivity();
        if (!row) { res.status(404).json({ error: 'No data' }); return; }
        res.json({ ok: true, data: row });
    });

    app.get('/v1/blocks/activity', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/blocks/activity' });
        const rows = await getBlockActivity(lim(req, 20, 200));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/blocks/activity/latest', async (req, res) => {
        if (!await auth(req, res)) return;
        const row = await getLatestBlockActivity();
        res.json({ ok: true, data: row });
    });

    app.get('/v1/blocks/activity/stats', async (req, res) => {
        if (!await auth(req, res)) return;
        res.json({ ok: true, data: await getActivityStats() });
    });

    // ── Events ────────────────────────────────────────────────────────────────
    app.get('/v1/events/recent', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/events/recent' });
        const type   = req.query_parameters['type'] ?? null;
        const limit  = lim(req, 50, 200);
        const cursor = cur(req);
        const rows   = await getRecentEvents(limit, type, cursor);
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/events/types', async (req, res) => {
        if (!await auth(req, res)) return;
        const rows = await getEventTypeSummary();
        res.json({ ok: true, data: rows });
    });

    // ── Contracts ─────────────────────────────────────────────────────────────
    app.get('/v1/contracts/top', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/contracts/top' });
        const rows = await getTopContracts(lim(req, 10, 50));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/contracts/:address/events', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/contracts/:address/events' });
        const type   = req.query_parameters['type'] ?? null;
        const limit  = lim(req, 50, 200);
        const cursor = cur(req);
        const rows   = await getContractEvents(req.params.address, limit, type, cursor);
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/contracts/:address/stats', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/contracts/:address/stats' });
        const data = await getContractStats(req.params.address);
        if (!data) { res.status(404).json({ error: 'Contract not found' }); return; }
        res.json({ ok: true, data });
    });

    // ── Tokens ────────────────────────────────────────────────────────────────
    app.get('/v1/tokens', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/tokens' });
        const rows = await getTokens(lim(req, 20, 100));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/tokens/:address', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/tokens/:address' });
        const row = await getToken(req.params.address);
        if (!row) { res.status(404).json({ error: 'Token not found' }); return; }
        res.json({ ok: true, data: row });
    });

    app.get('/v1/tokens/:address/transfers', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/tokens/:address/transfers' });
        const limit  = lim(req, 50, 200);
        const cursor = cur(req);
        const rows   = await getContractEvents(req.params.address, limit, 'Transferred', cursor);
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/tokens/:address/holders', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/tokens/:address/holders' });
        const rows = await getTokenHolders(req.params.address, lim(req, 50, 200));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    // ── Address (Alchemy-style) ───────────────────────────────────────────────
    app.get('/v1/address/:address', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/address/:address' });
        const [overview, tokens] = await Promise.all([
            getAddressOverview(req.params.address),
            getAddressTokenActivity(req.params.address, 10),
        ]);
        if (!overview || Number(overview.tx_count) === 0) {
            res.status(404).json({ error: 'Address not found' });
            return;
        }
        res.json({ ok: true, data: { ...overview, top_tokens: tokens } });
    });

    app.get('/v1/address/:address/txs', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/address/:address/txs' });
        const rows = await getAddressTxs(req.params.address, lim(req, 50, 200), cur(req));
        const nextCursor = rows.length > 0 ? rows[rows.length - 1]?.id ?? null : null;
        res.json({ ok: true, count: rows.length, next_cursor: nextCursor, data: rows });
    });

    app.get('/v1/address/:address/tokens', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/address/:address/tokens' });
        const rows = await getAddressTokenActivity(req.params.address, lim(req, 20, 100));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    // ── Transaction ───────────────────────────────────────────────────────────
    app.get('/v1/tx/:hash', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/tx/:hash' });
        const events = await getTxByHash(req.params.hash);
        if (events.length === 0) { res.status(404).json({ error: 'Transaction not found' }); return; }
        res.json({
            ok: true, tx: req.params.hash,
            block: events[0]?.block_height ?? null,
            events: events.length, data: events,
        });
    });

    // ── Oracle (Chainlink-style) ──────────────────────────────────────────────
    app.get('/v1/oracle/all', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/oracle/all' });
        const rows = await getAllLatestOraclePrices();
        res.json({ ok: true, count: rows.length, data: rows });
    });

    app.get('/v1/oracle/btc', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/oracle/btc' });
        const row = await getLatestOraclePrice('BTC/USD');
        if (!row) { res.status(503).json({ error: 'Oracle not yet available' }); return; }
        res.json({ ok: true, data: row });
    });

    app.get('/v1/oracle/pubkey', async (req, res) => {
        if (!await auth(req, res)) return;
        res.json({ ok: true, pubkey: getOraclePubKey() });
    });

    app.get('/v1/oracle/prices', async (req, res) => {
        if (!await auth(req, res)) return;
        const symbol = req.query_parameters['symbol'] ?? 'BTC/USD';
        const limit  = lim(req, 50, 500);
        const rows   = await getOraclePriceHistory(symbol, limit);
        res.json({ ok: true, symbol, count: rows.length, data: rows });
    });

    app.get('/v1/oracle/history', async (req, res) => {
        if (!await auth(req, res)) return;
        const symbol = req.query_parameters['symbol'] ?? 'BTC/USD';
        const limit  = lim(req, 50, 500);
        const rows   = await getOraclePriceHistory(symbol, limit);
        res.json({ ok: true, symbol, count: rows.length, data: rows });
    });

    // GET /v1/oracle/:symbol  and  /v1/oracle/:symbol/ohlcv
    // symbol format: BTC%2FUSD or BTC-USD
    app.get('/v1/oracle/:symbol', async (req, res) => {
        if (!await auth(req, res)) return;
        const symbol = decodeURIComponent(req.params.symbol).toUpperCase().replace('-', '/');
        incCounter('http_requests_total', { route: '/v1/oracle/:symbol' });
        const row = await getLatestOraclePrice(symbol);
        if (!row) { res.status(404).json({ error: `No data for ${symbol}` }); return; }
        res.json({ ok: true, data: row });
    });

    app.get('/v1/oracle/:symbol/ohlcv', async (req, res) => {
        if (!await auth(req, res)) return;
        const symbol   = decodeURIComponent(req.params.symbol).toUpperCase().replace('-', '/');
        const interval = (req.query_parameters['interval'] ?? '1h') as string;
        const limit    = lim(req, 50, 500);
        incCounter('http_requests_total', { route: '/v1/oracle/:symbol/ohlcv' });
        const rows = await getOhlcv(symbol, interval, limit);
        res.json({ ok: true, symbol, interval, count: rows.length, data: rows });
    });

    app.get('/v1/oracle/:symbol/history', async (req, res) => {
        if (!await auth(req, res)) return;
        const symbol = decodeURIComponent(req.params.symbol).toUpperCase().replace('-', '/');
        const limit  = lim(req, 50, 500);
        const rows   = await getOraclePriceHistory(symbol, limit);
        res.json({ ok: true, symbol, count: rows.length, data: rows });
    });

    // ── Analytics ─────────────────────────────────────────────────────────────
    app.get('/v1/analytics/volume', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/analytics/volume' });
        const contract = req.query_parameters['contract'] ?? null;
        const data     = await getVolumeAnalytics(contract);
        res.json({ ok: true, data });
    });

    app.get('/v1/analytics/trending', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/analytics/trending' });
        const rows = await getTrendingTokens(lim(req, 10, 50));
        res.json({ ok: true, count: rows.length, data: rows });
    });

    // ── Search ────────────────────────────────────────────────────────────────
    app.get('/v1/search', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/search' });
        const q = (req.query_parameters['q'] ?? '').trim();
        if (q.length < 2) { res.status(400).json({ error: 'q must be at least 2 characters' }); return; }
        if (q.length > 200) { res.status(400).json({ error: 'q too long' }); return; }
        const results = await globalSearch(q);
        res.json({ ok: true, query: q, data: results });
    });

    // ── Bets ──────────────────────────────────────────────────────────────────
    app.get('/v1/bets/stats', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/bets/stats' });
        const data = await getBetStats();
        res.json({ ok: true, data });
    });

    // ── RPC proxy ─────────────────────────────────────────────────────────────
    app.post('/v1/rpc', async (req, res) => {
        if (!await auth(req, res)) return;
        incCounter('http_requests_total', { route: '/v1/rpc' });
        await handleRpcProxy(req, res);
    });

    // ── GraphQL ───────────────────────────────────────────────────────────────
    app.any('/graphql', async (req, res) => {
        if (!await auth(req, res)) return;
        await handleGraphQL(req, res);
    });

    // ── Prometheus metrics ────────────────────────────────────────────────────
    app.get('/metrics', async (_req, res) => {
        await handleMetrics(res);
    });

    // ── Webhooks ──────────────────────────────────────────────────────────────
    app.post('/v1/webhooks', async (req, res) => {
        const keyId = await verifyApiKey(req, res);
        if (!keyId) return;
        const body = await req.json() as { url?: string; events?: string[]; contract?: string };
        if (!body.url || !body.events?.length) {
            res.status(400).json({ error: 'url and events required' });
            return;
        }
        const count = await countWebhooks(keyId);
        if (count >= 20) { res.status(429).json({ error: 'Max 20 webhooks per key' }); return; }
        const hook = await createWebhook(keyId, body.url, body.events, body.contract ?? null);
        res.status(201).json({ ok: true, data: hook });
    });

    app.get('/v1/webhooks', async (req, res) => {
        const keyId = await verifyApiKey(req, res);
        if (!keyId) return;
        const hooks = await listWebhooks(keyId);
        res.json({ ok: true, count: hooks.length, data: hooks });
    });

    app.delete('/v1/webhooks/:id', async (req, res) => {
        const keyId = await verifyApiKey(req, res);
        if (!keyId) return;
        await deleteWebhook(keyId, req.params.id);
        res.json({ ok: true });
    });

    app.patch('/v1/webhooks/:id', async (req, res) => {
        const keyId = await verifyApiKey(req, res);
        if (!keyId) return;
        const body = await req.json() as { active?: boolean };
        if (typeof body.active !== 'boolean') {
            res.status(400).json({ error: 'active (boolean) required' });
            return;
        }
        await toggleWebhook(keyId, req.params.id, body.active);
        res.json({ ok: true });
    });

    // ── Admin: API key management ─────────────────────────────────────────────
    app.post('/v1/admin/keys', async (req, res) => {
        if (!isAdminRequest(req)) { res.status(403).json({ error: 'Forbidden' }); return; }
        const body = await req.json() as { label?: string; rateLimit?: number };
        const rawKey = crypto.randomBytes(32).toString('hex');
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const row = await createApiKey(keyHash, body.label ?? 'default', body.rateLimit ?? 100);
        res.status(201).json({ ok: true, key: rawKey, data: row });
    });

    app.get('/v1/admin/keys', async (req, res) => {
        if (!isAdminRequest(req)) { res.status(403).json({ error: 'Forbidden' }); return; }
        const keys = await listApiKeys();
        res.json({ ok: true, data: keys });
    });
}
