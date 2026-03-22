/**
 * BlockFeed — Real-time Bitcoin mempool + OPNet data API
 *
 * REST endpoints:
 *   GET /v1/status
 *   GET /v1/fees/latest
 *   GET /v1/fees/history?blocks=50
 *   GET /v1/fees/stats
 *   GET /v1/mempool/depth
 *   GET /v1/blocks/latest
 *   GET /v1/bets/stats
 *
 * WebSocket:
 *   ws://host:3001/v1/stream  — pushes { type, data } on each new block
 */

import http from 'http';
import { CONFIG } from './config.js';
import { pool, ensureSchema } from './db.js';
import { startFeed } from './feed.js';
import { startIndexer } from './indexer.js';
import { handleRequest } from './routes.js';
import { applyMiddleware } from './middleware.js';
import { handleGraphQL } from './graphql.js';
import { startOracle } from './oracle.js';

const CORS_PREFLIGHT = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_PREFLIGHT);
    res.end();
    return;
  }

  // GraphQL — bypass rate limiting for introspection but apply for queries
  if (url.pathname === '/graphql') {
    const allowed = await applyMiddleware(req, res);
    if (!allowed) return;
    await handleGraphQL(req, res);
    return;
  }

  // Apply auth + rate limiting to all non-preflight requests
  const allowed = await applyMiddleware(req, res);
  if (!allowed) return;

  // Root — API index
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'BlockFeed',
      version: '0.1.0',
      network: 'op_testnet',
      docs: 'https://github.com/TornGuard/blockfeed',
      endpoints: [
        'GET  /v1/status',
        'GET  /v1/fees/latest',
        'GET  /v1/fees/history?blocks=50',
        'GET  /v1/fees/stats',
        'GET  /v1/mempool/depth',
        'GET  /v1/mempool/histogram',
        'GET  /v1/blocks/latest',
        'GET  /v1/blocks/activity?blocks=20',
        'GET  /v1/blocks/activity/latest',
        'GET  /v1/blocks/activity/stats',
        'GET  /v1/events/recent?limit=50&type=Transferred&cursor=<id>',
        'GET  /v1/events/types',
        'GET  /v1/contracts/top?limit=10',
        'GET  /v1/contracts/:address/events?limit=50&cursor=<id>&type=Transferred',
        'GET  /v1/contracts/:address/stats',
        'GET  /v1/tokens?limit=20',
        'GET  /v1/tokens/:address',
        'GET  /v1/tokens/:address/transfers?limit=50&cursor=<id>',
        'GET  /v1/bets/stats',
        'GET  /v1/oracle/btc',
        'GET  /v1/oracle/prices',
        'GET  /v1/oracle/history?symbol=BTC/USD&limit=50',
        'GET  /v1/oracle/pubkey',
        'POST /v1/webhooks  [x-api-key required]',
        'GET  /v1/webhooks  [x-api-key required]',
        'DELETE /v1/webhooks/:id  [x-api-key required]',
        'PATCH  /v1/webhooks/:id  [x-api-key required]',
        'WS   /v1/stream',
        'POST /graphql  (GraphQL API — same data, flexible queries)',
        'GET  /graphql  (GraphiQL playground)',
        'POST /v1/admin/keys  [x-admin-key required]',
        'GET  /v1/admin/keys  [x-admin-key required]',
      ],
    }, null, 2));
    return;
  }

  try {
    const handled = await handleRequest(req, res, url);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } catch (err) {
    console.error('[BlockFeed] Error:', err.message);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

// Attach WebSocket to same server
startFeed(server);

// Start
server.listen(CONFIG.port, async () => {
  console.log(`[BlockFeed] ✅ Running on port ${CONFIG.port}`);
  console.log(`[BlockFeed] REST: http://0.0.0.0:${CONFIG.port}/`);
  console.log(`[BlockFeed] WS:   ws://0.0.0.0:${CONFIG.port}/v1/stream`);

  // Verify DB + bootstrap schema + start indexer
  try {
    await pool.query('SELECT 1');
    console.log('[BlockFeed] ✅ Database connected');
    await ensureSchema();
    await startIndexer();
    await startOracle();
  } catch (err) {
    console.error('[BlockFeed] ❌ Startup error:', err.message);
  }
});
