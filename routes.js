import { getLatestFee, getFeeHistory, getFeeStats, getBetStats } from './db.js';
import { getConnectedClients } from './feed.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
};

function json(res, data, status = 200) {
  res.writeHead(status, CORS);
  res.end(JSON.stringify(data));
}

function formatFee(row) {
  return {
    block:   row.block_height,
    fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
    mempool: row.mempool_count,
    ts:      row.submitted_at,
  };
}

export async function handleRequest(req, res, url) {
  const path = url.pathname;
  const qs   = url.searchParams;

  // ── GET /v1/fees/latest ──────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/latest') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, {
      ok: true,
      data: formatFee(row),
    });
  }

  // ── GET /v1/fees/history?blocks=50 ───────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/history') {
    const limit = Math.min(Number(qs.get('blocks') || 50), 500);
    const rows  = await getFeeHistory(limit);
    return json(res, {
      ok:    true,
      count: rows.length,
      data:  rows.map(formatFee),
    });
  }

  // ── GET /v1/fees/stats ───────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/fees/stats') {
    const stats = await getFeeStats();
    return json(res, { ok: true, data: stats });
  }

  // ── GET /v1/mempool/depth ────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/mempool/depth') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, {
      ok: true,
      data: {
        block:   row.block_height,
        mempool: row.mempool_count,
        fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
        ts:      row.submitted_at,
      },
    });
  }

  // ── GET /v1/blocks/latest ────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/blocks/latest') {
    const row = await getLatestFee();
    if (!row) return json(res, { error: 'No data yet' }, 503);
    return json(res, {
      ok: true,
      data: {
        block: row.block_height,
        ts:    row.submitted_at,
      },
    });
  }

  // ── GET /v1/bets/stats ───────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/bets/stats') {
    const stats = await getBetStats();
    return json(res, { ok: true, data: stats });
  }

  // ── GET /v1/status ───────────────────────────────────────────
  if (req.method === 'GET' && path === '/v1/status') {
    const latest = await getLatestFee();
    return json(res, {
      ok:      true,
      service: 'BlockFeed',
      version: '0.1.0',
      network: 'op_testnet',
      latest_block: latest?.block_height || null,
      ws_clients:   getConnectedClients(),
      uptime:       Math.floor(process.uptime()),
    });
  }

  return null; // not handled
}
