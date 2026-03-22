import { WebSocketServer } from 'ws';
import { getLatestFee } from './db.js';

let wss = null;
let lastBroadcastHeight = 0;

function formatBlock(row) {
  return {
    block: row.block_height,
    fee:   parseFloat((row.median_fee_scaled / 100).toFixed(2)),
    mempool: row.mempool_count,
    ts: row.submitted_at,
  };
}

export function startFeed(server) {
  wss = new WebSocketServer({ server, path: '/v1/stream' });

  wss.on('connection', async (ws, req) => {
    const ip = req.socket.remoteAddress;
    console.log(`[Feed] Client connected — ${ip} (${wss.clients.size} total)`);

    // Send latest block immediately on connect
    try {
      const latest = await getLatestFee();
      if (latest) ws.send(JSON.stringify({ type: 'snapshot', data: formatBlock(latest) }));
    } catch { /* non-fatal */ }

    ws.on('close', () => console.log(`[Feed] Client disconnected (${wss.clients.size} remaining)`));
    ws.on('error', () => {});
  });

  // Poll DB every 15s and broadcast new blocks to all clients
  setInterval(async () => {
    if (!wss || wss.clients.size === 0) return;
    try {
      const latest = await getLatestFee();
      if (!latest || latest.block_height <= lastBroadcastHeight) return;
      lastBroadcastHeight = latest.block_height;
      const payload = JSON.stringify({ type: 'block', data: formatBlock(latest) });
      for (const client of wss.clients) {
        if (client.readyState === 1) client.send(payload);
      }
      console.log(`[Feed] Broadcast block #${latest.block_height} to ${wss.clients.size} clients`);
    } catch { /* non-fatal */ }
  }, 15_000);

  console.log(`[Feed] WebSocket stream ready at /v1/stream`);
}

export function getConnectedClients() {
  return wss ? wss.clients.size : 0;
}

export function broadcast(type, data) {
  if (!wss || wss.clients.size === 0) return;
  const payload = JSON.stringify({ type, data });
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(payload);
  }
}
