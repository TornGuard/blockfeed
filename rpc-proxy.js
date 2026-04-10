/**
 * OPNet JSON-RPC Proxy
 *
 * Forwards POST /v1/rpc requests to the upstream OPNet node, acting as an
 * authenticated, rate-limited gateway — identical to what Alchemy/Infura
 * provide for EVM networks.
 *
 * Supports:
 *   - Single requests:  { jsonrpc, method, params, id }
 *   - Batch requests:   [ { jsonrpc, method, params, id }, ... ]
 *
 * Blocked methods (no read-your-own-writes risk, but prevent resource abuse):
 *   - eth_sendRawTransaction  → blocked (use native OPNet wallet, not raw txs)
 *   - debug_* / admin_*      → blocked (node internals)
 *
 * The upstream URL is pulled from config so it can be swapped to mainnet.
 */

import { incCounter } from './metrics.js';

const UPSTREAM      = process.env.OPNET_RPC_URL ?? 'https://testnet.opnet.org/api/v1/json-rpc';
const TIMEOUT_MS    = 20_000;
const MAX_BATCH     = 20;
const MAX_BODY_BYTES = 64 * 1024; // 64 KB

const BLOCKED = new Set([
  'eth_sendRawTransaction',
  'debug_traceTransaction',
  'debug_traceCall',
  'admin_addPeer',
  'admin_removePeer',
  'admin_nodeInfo',
  'admin_datadir',
  'personal_unlockAccount',
  'personal_importRawKey',
]);

// ── Forward a single RPC call ─────────────────────────────────────────────────
async function forwardOne(call) {
  const { method, params = [], id = 1 } = call;

  if (BLOCKED.has(method)) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method ${method} is not available` } };
  }

  // Block methods by prefix
  if (method.startsWith('debug_') || method.startsWith('admin_') || method.startsWith('personal_')) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not available' } };
  }

  try {
    const res = await fetch(UPSTREAM, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent':   'BlockFeed-Proxy/1.0',
        Accept:         'application/json',
      },
      body:   JSON.stringify({ jsonrpc: '2.0', method, params, id }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: `Upstream HTTP ${res.status}` } };
    }

    return await res.json();
  } catch (err) {
    const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
    return {
      jsonrpc: '2.0', id,
      error: { code: timedOut ? -32603 : -32603, message: timedOut ? 'Upstream timeout' : `Upstream error: ${err.message}` },
    };
  }
}

// ── Read and parse request body ───────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('Request body too large'));
        return;
      }
      buf += chunk;
    });
    req.on('end', () => {
      try { resolve(JSON.parse(buf)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// ── Public handler ────────────────────────────────────────────────────────────
/**
 * Handle POST /v1/rpc.
 * Accepts both single RPC objects and JSON arrays (batch).
 */
export async function handleRpcProxy(req, res) {
  incCounter('rpc_proxy_requests_total');

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: err.message } }));
    return;
  }

  const isBatch = Array.isArray(body);

  if (isBatch) {
    if (body.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } }));
      return;
    }
    if (body.length > MAX_BATCH) {
      res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Batch too large (max ${MAX_BATCH})` } }));
      return;
    }

    const results = await Promise.all(body.map(forwardOne));
    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(results));
    return;
  }

  const result = await forwardOne(body);
  res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(result));
}
