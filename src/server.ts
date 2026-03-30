/**
 * BlockFeed — Bitcoin + OPNet Data API
 *
 * Scaled to Chainlink-level price feeds and Alchemy-level node access.
 * Powered by @btc-vision/hyper-express + @btc-vision/uwebsocket.js.
 */

import HyperExpress from '@btc-vision/hyper-express';
import { Worker } from 'worker_threads';
import { fileURLToPath } from 'url';
import path from 'path';
import { Config } from './config.js';
import { pool, ensureSchema } from './db.js';
import { startFeed } from './feed.js';
import { registerRoutes } from './router.js';
import type { WorkerMsg } from './types.js';
import { broadcast } from './feed.js';
import { setGauge, incCounter } from './metrics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── HyperExpress server ───────────────────────────────────────────────────────
const app = new HyperExpress.Server({
    max_body_length:  1024 * 1024 * 8, // 8 MB
    fast_abort:       true,
    max_body_buffer:  1024 * 32,        // 32 KB
    idle_timeout:     60,
    response_timeout: 120,
});

app.set_error_handler((_req, res, err) => {
    incCounter('http_errors_total');
    console.error('[BlockFeed] Unhandled error:', err.message);
    if (res.closed) return;
    res.atomic(() => {
        res.status(500);
        res.json({ error: 'Internal server error' });
    });
});

// ── CORS middleware ───────────────────────────────────────────────────────────
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin',  '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Api-Key, X-Admin-Key');
    incCounter('http_requests_total', { route: req.path });

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    next();
});

// ── Register all REST routes + WebSocket ──────────────────────────────────────
registerRoutes(app);
startFeed(app.uws_instance);

// ── Worker: Indexer ───────────────────────────────────────────────────────────
function startWorker(scriptPath: string, label: string): Worker {
    const worker = new Worker(scriptPath);
    worker.on('message', (msg: WorkerMsg) => {
        if (msg.type === 'broadcast') {
            broadcast(msg);
        } else if (msg.type === 'log') {
            const fn = msg.level === 'error' ? console.error
                     : msg.level === 'warn'  ? console.warn
                     : console.log;
            fn(`[${label}] ${msg.message}`);
        }
    });
    worker.on('error', (err) => console.error(`[${label}] Worker error:`, (err as Error).message));
    worker.on('exit',  (code) => {
        if (code !== 0) {
            console.error(`[${label}] Worker exited with code ${code} — restarting in 5s`);
            setTimeout(() => startWorker(scriptPath, label), 5_000);
        }
    });
    return worker;
}

// ── Boot ──────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
    await pool.query('SELECT 1');
    console.log('[BlockFeed] ✅ Database connected');

    await ensureSchema();

    // Start workers
    startWorker(path.join(__dirname, '../workers/indexer-worker.js'), 'Indexer');
    startWorker(path.join(__dirname, '../workers/oracle-worker.js'),  'Oracle');

    await app.listen(Config.port);

    setGauge('process_uptime_seconds', 0);
    setInterval(() => setGauge('process_uptime_seconds', Math.floor(process.uptime())), 10_000);

    console.log('');
    console.log('  ╔══════════════════════════════════════════╗');
    console.log('  ║       BlockFeed v1.0.0                   ║');
    console.log('  ║  Bitcoin + OPNet Data API                ║');
    console.log('  ╚══════════════════════════════════════════╝');
    console.log('');
    console.log(`  REST:    http://0.0.0.0:${Config.port}/`);
    console.log(`  WS:      ws://0.0.0.0:${Config.port}/v1/stream`);
    console.log(`  RPC:     POST http://0.0.0.0:${Config.port}/v1/rpc`);
    console.log(`  Metrics: http://0.0.0.0:${Config.port}/metrics`);
    console.log('');
}

boot().catch((err) => {
    console.error('[BlockFeed] ❌ Startup error:', err.message);
    process.exit(1);
});
