/**
 * BlockFeed Price Oracle
 *
 * Aggregates BTC/USD from 4 independent sources every 60s.
 * Each price update is:
 *   - Median-aggregated (outliers >2% from median are dropped)
 *   - Confidence-scored (spread % — lower is tighter/better)
 *   - Signed with ed25519 so on-chain contracts can verify authenticity
 *   - Broadcast over WebSocket to all connected clients
 *   - Stored in oracle_prices table
 *
 * Consumers verify a price with:
 *   const msg = Buffer.from(`BTC/USD:${priceScaled}:${capturedAtMs}`);
 *   crypto.verify(null, msg, pubKeyDer, Buffer.from(signature, 'hex'))
 */

import crypto from 'crypto';
import { storeOraclePrice, getLatestOraclePrice } from './db.js';
import { broadcast } from './feed.js';

const POLL_INTERVAL = 60_000; // 60s — aggressive enough for DeFi
const OUTLIER_THRESHOLD = 0.02; // 2% deviation triggers drop
const MIN_SOURCES = 2; // skip round if fewer than this succeed
const FETCH_TIMEOUT = 6_000;

// ── Key management ────────────────────────────────────────────────────────────
let _privKey = null;
let _pubKeyDer = null;

function loadKeys() {
  if (_privKey) return;

  const envKey = process.env.ORACLE_PRIVATE_KEY;
  if (envKey) {
    try {
      _privKey = crypto.createPrivateKey({
        key:    Buffer.from(envKey, 'base64'),
        format: 'der',
        type:   'pkcs8',
      });
      console.log('[Oracle] Loaded signing key from ORACLE_PRIVATE_KEY');
    } catch {
      console.error('[Oracle] Invalid ORACLE_PRIVATE_KEY — generating ephemeral key');
    }
  }

  if (!_privKey) {
    const { privateKey } = crypto.generateKeyPairSync('ed25519');
    _privKey = privateKey;
    const der = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    console.warn('[Oracle] ⚠  No ORACLE_PRIVATE_KEY set. Ephemeral key in use.');
    console.warn('[Oracle] To persist across restarts, add to .env:');
    console.warn(`[Oracle]   ORACLE_PRIVATE_KEY=${der}`);
  }

  _pubKeyDer = crypto.createPublicKey(_privKey)
    .export({ type: 'spki', format: 'der' })
    .toString('hex');
}

export function getOraclePubKey() {
  loadKeys();
  return _pubKeyDer;
}

function sign(symbol, priceScaled, capturedAtMs) {
  const msg = Buffer.from(`${symbol}:${priceScaled}:${capturedAtMs}`);
  return crypto.sign(null, msg, _privKey).toString('hex');
}

// ── Price sources ─────────────────────────────────────────────────────────────
const SOURCES = {
  coinbase: async () => {
    const r = await fetch('https://api.coinbase.com/v2/prices/BTC-USD/spot',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const j = await r.json();
    return parseFloat(j.data.amount);
  },
  binance: async () => {
    const r = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const j = await r.json();
    return parseFloat(j.price);
  },
  kraken: async () => {
    const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const j = await r.json();
    return parseFloat(j.result.XXBTZUSD.c[0]);
  },
  coingecko: async () => {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    const j = await r.json();
    return j.bitcoin.usd;
  },
};

// ── Aggregation ───────────────────────────────────────────────────────────────
function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function fetchAll() {
  const results = await Promise.allSettled(
    Object.entries(SOURCES).map(async ([name, fn]) => {
      const price = await fn();
      if (!Number.isFinite(price) || price <= 0) throw new Error('bad price');
      return { name, price };
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
}

function aggregate(raw) {
  if (raw.length < MIN_SOURCES) return null;

  const prices  = raw.map(r => r.price);
  const med     = median(prices);

  // Drop outliers
  const filtered = raw.filter(r => Math.abs(r.price - med) / med <= OUTLIER_THRESHOLD);
  if (filtered.length < MIN_SOURCES) return null;

  const filteredPrices = filtered.map(r => r.price);
  const finalMed  = median(filteredPrices);
  const spread    = Math.max(...filteredPrices) - Math.min(...filteredPrices);
  const confidence = parseFloat((spread / finalMed).toFixed(6)); // lower = better

  const sources = Object.fromEntries(filtered.map(r => [r.name, r.price]));

  return { price: finalMed, sources, confidence };
}

// ── Oracle tick ───────────────────────────────────────────────────────────────
async function tick() {
  const raw = await fetchAll();
  const agg = aggregate(raw);

  if (!agg) {
    const names = raw.map(r => r.name).join(', ') || 'none';
    console.warn(`[Oracle] Skipped round — insufficient sources (got: ${names})`);
    return;
  }

  const { price, sources, confidence } = agg;
  const symbol      = 'BTC/USD';
  const priceScaled = Math.round(price * 1e8); // satoshis-style integer
  const now         = Date.now();
  const signature   = sign(symbol, priceScaled, now);

  const row = await storeOraclePrice(symbol, price, sources, confidence, signature);

  const payload = {
    id:          row.id,
    symbol,
    price,
    price_scaled: priceScaled,
    confidence,
    sources,
    signature,
    pubkey:      _pubKeyDer,
    captured_at: row.captured_at,
  };

  broadcast('oracle_price', payload);

  console.log(
    `[Oracle] BTC/USD $${price.toFixed(2)}  confidence=${(confidence * 100).toFixed(3)}%` +
    `  sources=${Object.keys(sources).join(',')}`,
  );
}

// ── Public API ────────────────────────────────────────────────────────────────
export async function startOracle() {
  loadKeys();
  console.log(`[Oracle] Starting price oracle (every ${POLL_INTERVAL / 1000}s)`);
  console.log(`[Oracle] Public key: ${_pubKeyDer}`);

  // Run immediately, then on interval
  tick().catch(err => console.error('[Oracle] tick error:', err.message));
  setInterval(() => {
    tick().catch(err => console.error('[Oracle] tick error:', err.message));
  }, POLL_INTERVAL);
}

export { getLatestOraclePrice, getOraclePriceHistory, getOracleSymbols } from './db.js';
