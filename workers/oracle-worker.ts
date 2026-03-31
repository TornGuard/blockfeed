/**
 * Oracle Worker Thread
 *
 * Polls external price APIs for BTC/USD.
 * Aggregates using median consensus. Signs each tick with ed25519.
 * Writes to oracle_prices table and notifies main thread for WebSocket broadcast.
 */

import { parentPort } from 'worker_threads';
import crypto from 'crypto';
import 'dotenv/config';
import { pool, storeOraclePrice } from '../src/db.js';
import type { WorkerMsg } from '../src/types.js';

const POLL_INTERVAL_MS  = 60_000;
const FETCH_TIMEOUT_MS  = 8_000;
const MIN_SOURCES       = 2;

// ── Signing key ───────────────────────────────────────────────────────────────
let _privateKey: crypto.KeyObject | null = null;
let _pubKeyDer  = '';

function loadKeys(): void {
    const raw = process.env['ORACLE_PRIVATE_KEY'];
    if (raw) {
        try {
            _privateKey = crypto.createPrivateKey({
                key:    Buffer.from(raw, 'base64'),
                format: 'der',
                type:   'pkcs8',
            });
        } catch {
            log('warn', 'ORACLE_PRIVATE_KEY invalid — generating ephemeral key');
        }
    }
    if (!_privateKey) {
        const { privateKey } = crypto.generateKeyPairSync('ed25519');
        _privateKey = privateKey;
    }
    const pub = crypto.createPublicKey(_privateKey);
    _pubKeyDer = pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

function sign(symbol: string, priceScaled: number, ts: number): string {
    const msg = Buffer.from(`${symbol}:${priceScaled}:${ts}`);
    return crypto.sign(null, msg, _privateKey!).toString('base64');
}

export function getOraclePubKey(): string { return _pubKeyDer; }

// ── Price source definitions ──────────────────────────────────────────────────
type PriceFn = () => Promise<number>;

interface SymbolSources { [name: string]: PriceFn }

const SYMBOLS: Record<string, SymbolSources> = {
    'BTC/USD': {
        coinbase:  () => fetchJson<{ data: { amount: string } }>('https://api.coinbase.com/v2/prices/BTC-USD/spot').then(j => parseFloat(j.data.amount)),
        binance:   () => fetchJson<{ price: string }>('https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT').then(j => parseFloat(j.price)),
        kraken:    () => fetchJson<{ result: { XXBTZUSD: { c: string[] } } }>('https://api.kraken.com/0/public/Ticker?pair=XBTUSD').then(j => parseFloat(j.result.XXBTZUSD.c[0])),
        coingecko: () => fetchJson<{ bitcoin: { usd: number } }>('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd').then(j => j.bitcoin.usd),
    },
};

async function fetchJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json() as Promise<T>;
}

function median(arr: number[]): number {
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m]! : ((s[m - 1]! + s[m]!) / 2);
}

// ── Per-symbol fetch + store ──────────────────────────────────────────────────
async function tickSymbol(symbol: string): Promise<void> {
    const sources = SYMBOLS[symbol];
    if (!sources) return;

    const results = await Promise.allSettled(
        Object.entries(sources).map(async ([name, fn]): Promise<{ name: string; price: number }> => {
            const price = await fn();
            if (!Number.isFinite(price) || price <= 0) throw new Error(`bad price from ${name}`);
            return { name, price };
        }),
    );

    const successful = results
        .filter((r): r is PromiseFulfilledResult<{ name: string; price: number }> => r.status === 'fulfilled')
        .map(r => r.value);

    if (successful.length < MIN_SOURCES) {
        log('warn', `${symbol}: only ${successful.length} sources — skipping`);
        return;
    }

    const prices     = successful.map(s => s.price);
    const mid        = median(prices);
    const maxDev     = Math.max(...prices.map(p => Math.abs(p - mid) / mid));
    const confidence = Math.max(0, 1 - maxDev * 10);
    const usedSources = Object.fromEntries(successful.map(s => [s.name, s.price]));

    const priceScaled = Math.round(mid * 1e8);
    const now         = Date.now();
    const signature   = sign(symbol, priceScaled, now);

    const row = await storeOraclePrice(symbol, mid, usedSources, confidence, signature);

    const payload = {
        id:           row.id,
        symbol,
        price:        mid,
        price_scaled: priceScaled,
        confidence,
        sources:      usedSources,
        signature,
        pubkey:       _pubKeyDer,
        captured_at:  row.captured_at,
    };

    const msg: WorkerMsg = { type: 'broadcast', event: 'oracle_price', data: payload };
    parentPort?.postMessage(msg);

    const dp = symbol === 'BTC/USD' ? 2 : 4;
    log('info', `${symbol} $${mid.toFixed(dp)}  confidence=${(confidence * 100).toFixed(2)}%  sources=${successful.map(s => s.name).join(',')}`);
}

async function tickAll(): Promise<void> {
    const symbols = Object.keys(SYMBOLS);
    for (let i = 0; i < symbols.length; i++) {
        if (i > 0) await new Promise<void>(r => setTimeout(r, 2_000));
        await tickSymbol(symbols[i]!).catch(err => log('error', `${symbols[i]} error: ${String(err)}`));
    }
}

function log(level: 'info' | 'warn' | 'error', message: string): void {
    const msg: WorkerMsg = { type: 'log', level, message };
    parentPort?.postMessage(msg);
}

async function run(): Promise<void> {
    loadKeys();
    await pool.query('SELECT 1');
    log('info', `Oracle worker started — symbols: ${Object.keys(SYMBOLS).join(', ')}`);
    log('info', `Public key: ${_pubKeyDer}`);

    tickAll().catch(err => log('error', String(err)));
    setInterval(() => tickAll().catch(err => log('error', String(err))), POLL_INTERVAL_MS);
}

run().catch(err => {
    log('error', `Fatal: ${String(err)}`);
    process.exit(1);
});
