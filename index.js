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
import { pool } from './db.js';
import { startFeed } from './feed.js';
import { handleRequest } from './routes.js';

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

  // Root — API index
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      service: 'BlockFeed',
      version: '0.1.0',
      network: 'op_testnet',
      docs: 'https://github.com/TornGuard/blockfeed',
      endpoints: [
        'GET /v1/status',
        'GET /v1/fees/latest',
        'GET /v1/fees/history?blocks=50',
        'GET /v1/fees/stats',
        'GET /v1/mempool/depth',
        'GET /v1/blocks/latest',
        'GET /v1/bets/stats',
        'WS  /v1/stream',
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
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Internal server error' }));
  }
});

// Attach WebSocket to same server
startFeed(server);

// Start
server.listen(CONFIG.port, async () => {
  console.log(`[BlockFeed] ✅ Running on port ${CONFIG.port}`);
  console.log(`[BlockFeed] REST: http://0.0.0.0:${CONFIG.port}/`);
  console.log(`[BlockFeed] WS:   ws://0.0.0.0:${CONFIG.port}/v1/stream`);

  // Verify DB connection
  try {
    await pool.query('SELECT 1');
    console.log('[BlockFeed] ✅ Database connected');
  } catch (err) {
    console.error('[BlockFeed] ❌ Database connection failed:', err.message);
  }
});
