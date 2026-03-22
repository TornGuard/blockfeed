import crypto from 'crypto';
import {
  getLatestOraclePrice, getOraclePriceHistory, getOracleSymbols,
} from './db.js';
import { getOraclePubKey } from './oracle.js';
import {
  getLatestFee, getFeeHistory, getFeeStats, getBetStats,
  getBlockActivity, getLatestBlockActivity, getActivityStats,
  getRecentEvents, getTopContracts, getEventTypeSummary,
  getLatestHistogram,
  getToken, getTokens,
  getContractEvents, getContractStats,
  createApiKey, listApiKeys,
  createWebhook, listWebhooks, deleteWebhook, toggleWebhook, countWebhooks,
} from './db.js';
import { getConnectedClients } from './feed.js';
import { isAdminRequest } from './middleware.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, X-Admin-Key',
  'Content-Type': 'application/json',
};

// ── Helpers ───────────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
  return true;
}

function formatFee(row) {
  return {
    block:   row.block_height,
    fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
    mempool: row.mempool_count,
    ts:      row.submitted_at,
  };
}

function parseCursor(qs) {
  const raw = qs.get('cursor');
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseLimit(qs, def = 20, max = 200) {
  const n = parseInt(qs.get('limit') || qs.get('blocks') || def, 10);
  return Math.min(Number.isFinite(n) && n > 0 ? n : def, max);
}

function withCursor(rows, idField = 'id') {
  const next = rows.length > 0 ? rows[rows.length - 1][idField] : null;
  return { next_cursor: next };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 4096) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

// ── Router ────────────────────────────────────────────────────────────────────
export async function handleRequest(req, res, url) {
  const path = url.pathname;
  const qs   = url.searchParams;

  // ── GET /v1/status ───────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/status') {
    const latest = await getLatestFee();
    return json(res, {
      ok:           true,
      service:      'BlockFeed',
      version:      '0.2.0',
      network:      'op_testnet',
      latest_block: latest?.block_height || null,
      ws_clients:   getConnectedClients(),
      uptime:       Math.floor(process.uptime()),
    });
  }

  // ── GET /v1/fees/latest ──────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/latest') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, { ok: true, data: formatFee(row) });
  }

  // ── GET /v1/fees/history ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/history') {
    const limit = parseLimit(qs, 50, 500);
    const rows  = await getFeeHistory(limit);
    return json(res, { ok: true, count: rows.length, data: rows.map(formatFee) });
  }

  // ── GET /v1/fees/stats ───────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/stats') {
    return json(res, { ok: true, data: await getFeeStats() });
  }

  // ── GET /v1/mempool/depth ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/mempool/depth') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, { ok: true, data: {
      block:   row.block_height,
      mempool: row.mempool_count,
      fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
      ts:      row.submitted_at,
    }});
  }

  // ── GET /v1/mempool/histogram ────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/mempool/histogram') {
    const snap = await getLatestHistogram();
    if (!snap) return json(res, { error: 'No histogram yet' }, 503);
    return json(res, { ok: true, data: snap });
  }

  // ── GET /v1/blocks/latest ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/blocks/latest') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, { ok: true, data: { block: row.block_height, ts: row.submitted_at } });
  }

  // ── GET /v1/blocks/activity ──────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/blocks/activity') {
    const limit = parseLimit(qs, 20, 200);
    const rows  = await getBlockActivity(limit);
    return json(res, { ok: true, count: rows.length, data: rows });
  }

  // ── GET /v1/blocks/activity/latest ──────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/blocks/activity/latest') {
    const row = await getLatestBlockActivity();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, { ok: true, data: row });
  }

  // ── GET /v1/blocks/activity/stats ───────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/blocks/activity/stats') {
    return json(res, { ok: true, data: await getActivityStats() });
  }

  // ── GET /v1/events/recent ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/events/recent') {
    const limit  = parseLimit(qs, 50, 200);
    const cursor = parseCursor(qs);
    const type   = qs.get('type') || null;
    const rows   = await getRecentEvents(limit, type, cursor);
    return json(res, { ok: true, count: rows.length, ...withCursor(rows), data: rows });
  }

  // ── GET /v1/events/types ─────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/events/types') {
    return json(res, { ok: true, data: await getEventTypeSummary() });
  }

  // ── GET /v1/contracts/top ────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/contracts/top') {
    const limit = parseLimit(qs, 10, 50);
    return json(res, { ok: true, data: await getTopContracts(limit) });
  }

  // ── GET /v1/contracts/:address/events ────────────────────────────────────
  if (req.method === 'GET' && /^\/v1\/contracts\/0x[0-9a-f]+\/events$/.test(path)) {
    const address = path.split('/')[3];
    const limit   = parseLimit(qs, 50, 200);
    const cursor  = parseCursor(qs);
    const type    = qs.get('type') || null;
    const rows    = await getContractEvents({ address, limit, cursor, type });
    return json(res, { ok: true, count: rows.length, ...withCursor(rows), data: rows });
  }

  // ── GET /v1/contracts/:address/stats ─────────────────────────────────────
  if (req.method === 'GET' && /^\/v1\/contracts\/0x[0-9a-f]+\/stats$/.test(path)) {
    const address = path.split('/')[3];
    const stats   = await getContractStats(address);
    if (!stats || stats.total_events === 0) return json(res, { error: 'Not found' }, 404);
    return json(res, { ok: true, data: stats });
  }

  // ── GET /v1/tokens ───────────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/tokens') {
    const limit  = parseLimit(qs, 20, 100);
    const cursor = qs.get('cursor') || null;
    const rows   = await getTokens({ limit, cursor });
    return json(res, { ok: true, count: rows.length, data: rows });
  }

  // ── GET /v1/tokens/:address ──────────────────────────────────────────────
  if (req.method === 'GET' && /^\/v1\/tokens\/0x[0-9a-f]+$/.test(path)) {
    const address = path.split('/')[3];
    const token   = await getToken(address);
    if (!token) return json(res, { error: 'Token not found' }, 404);
    return json(res, { ok: true, data: token });
  }

  // ── GET /v1/tokens/:address/transfers ────────────────────────────────────
  if (req.method === 'GET' && /^\/v1\/tokens\/0x[0-9a-f]+\/transfers$/.test(path)) {
    const address = path.split('/')[3];
    const limit   = parseLimit(qs, 50, 200);
    const cursor  = parseCursor(qs);
    const rows    = await getContractEvents({ address, limit, cursor, type: 'Transferred' });
    return json(res, { ok: true, count: rows.length, ...withCursor(rows), data: rows });
  }

  // ── GET /v1/bets/stats ───────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/bets/stats') {
    return json(res, { ok: true, data: await getBetStats() });
  }

  // ── Oracle ────────────────────────────────────────────────────────────────

  // GET /v1/oracle/pubkey — ed25519 public key (hex SPKI DER) for signature verification
  if (req.method === 'GET' && path === '/v1/oracle/pubkey') {
    return json(res, { ok: true, data: { pubkey: getOraclePubKey(), algorithm: 'ed25519' } });
  }

  // GET /v1/oracle/prices — latest price for all tracked symbols
  if (req.method === 'GET' && path === '/v1/oracle/prices') {
    const rows = await getOracleSymbols();
    return json(res, { ok: true, data: rows });
  }

  // GET /v1/oracle/btc — latest BTC/USD price with signature
  if (req.method === 'GET' && path === '/v1/oracle/btc') {
    const row = await getLatestOraclePrice('BTC/USD');
    if (!row) return json(res, { error: 'No oracle data yet' }, 503);
    return json(res, { ok: true, data: row });
  }

  // GET /v1/oracle/history?symbol=BTC/USD&limit=50
  if (req.method === 'GET' && path === '/v1/oracle/history') {
    const symbol = qs.get('symbol') || 'BTC/USD';
    const limit  = parseLimit(qs, 50, 500);
    const rows   = await getOraclePriceHistory(symbol, limit);
    return json(res, { ok: true, count: rows.length, data: rows });
  }

  // ── Webhook CRUD (requires API key, not public) ───────────────────────────

  // POST /v1/webhooks — register a webhook
  if (req.method === 'POST' && path === '/v1/webhooks') {
    const entry = req.apiKeyEntry;
    if (!entry) return json(res, { error: 'API key required to manage webhooks' }, 401);

    const LIMITS = { free: 5, pro: 25, enterprise: Infinity };
    const cap = LIMITS[entry.tier] ?? LIMITS.free;
    const current = await countWebhooks(entry.key);
    if (current >= cap) return json(res, { error: `Webhook limit reached (${cap} for ${entry.tier} tier)` }, 429);

    let body;
    try { body = await readBody(req); } catch { return json(res, { error: 'Invalid JSON' }, 400); }

    const url = String(body.url || '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return json(res, { error: 'url must be a valid http/https URL' }, 400);
    }
    if (url.length > 2048) return json(res, { error: 'url too long' }, 400);

    const eventType = body.event_type ? String(body.event_type).trim().slice(0, 64) : null;
    const contract  = body.contract_address ? String(body.contract_address).trim() : null;
    if (contract && !/^0x[0-9a-f]+$/i.test(contract)) {
      return json(res, { error: 'invalid contract_address' }, 400);
    }

    const secret = crypto.randomBytes(24).toString('hex');
    const row = await createWebhook(entry.key, url, secret, eventType, contract);
    return json(res, {
      ok:     true,
      data:   { id: row.id, url, event_type: eventType, contract_address: contract, secret, created_at: row.created_at },
      notice: 'Save the secret — it will not be shown again.',
    }, 201);
  }

  // GET /v1/webhooks — list own webhooks
  if (req.method === 'GET' && path === '/v1/webhooks') {
    const entry = req.apiKeyEntry;
    if (!entry) return json(res, { error: 'API key required' }, 401);
    const hooks = await listWebhooks(entry.key);
    return json(res, { ok: true, count: hooks.length, data: hooks });
  }

  // DELETE /v1/webhooks/:id — remove a webhook
  if (req.method === 'DELETE' && /^\/v1\/webhooks\/\d+$/.test(path)) {
    const entry = req.apiKeyEntry;
    if (!entry) return json(res, { error: 'API key required' }, 401);
    const id = parseInt(path.split('/')[3], 10);
    const ok = await deleteWebhook(id, entry.key);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    return json(res, { ok: true });
  }

  // PATCH /v1/webhooks/:id — toggle active/inactive
  if (req.method === 'PATCH' && /^\/v1\/webhooks\/\d+$/.test(path)) {
    const entry = req.apiKeyEntry;
    if (!entry) return json(res, { error: 'API key required' }, 401);
    let body;
    try { body = await readBody(req); } catch { return json(res, { error: 'Invalid JSON' }, 400); }
    if (typeof body.active !== 'boolean') return json(res, { error: 'active (boolean) required' }, 400);
    const id = parseInt(path.split('/')[3], 10);
    const ok = await toggleWebhook(id, entry.key, body.active);
    if (!ok) return json(res, { error: 'Not found' }, 404);
    return json(res, { ok: true, active: body.active });
  }

  // ── POST /v1/admin/keys ──────────────────────────────────────────────────
  if (req.method === 'POST' && path === '/v1/admin/keys') {
    if (!isAdminRequest(req)) {
      return json(res, { error: 'Forbidden' }, 403);
    }
    let body;
    try { body = await readBody(req); } catch { return json(res, { error: 'Invalid JSON' }, 400); }

    const name = String(body.name || '').trim().slice(0, 100);
    const tier = ['free', 'pro', 'enterprise'].includes(body.tier) ? body.tier : 'free';
    if (!name) return json(res, { error: 'name is required' }, 400);

    const key = crypto.randomBytes(32).toString('hex');
    await createApiKey(key, name, tier);
    return json(res, { ok: true, data: { key, name, tier } }, 201);
  }

  // ── GET /v1/admin/keys ───────────────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/admin/keys') {
    if (!isAdminRequest(req)) return json(res, { error: 'Forbidden' }, 403);
    const keys = await listApiKeys();
    return json(res, { ok: true, data: keys });
  }

  return null; // not handled
}
