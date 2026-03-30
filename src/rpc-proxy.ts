/**
 * OPNet JSON-RPC Proxy — POST /v1/rpc
 *
 * Authenticated, rate-limited gateway to the OPNet node.
 * Supports single requests and batch arrays (max 20 per batch).
 */

import HyperExpress from '@btc-vision/hyper-express';
import { Config } from './config.js';
import { incCounter } from './metrics.js';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

const TIMEOUT_MS  = 20_000;
const MAX_BATCH   = 20;

const BLOCKED = new Set([
    'eth_sendRawTransaction',
    'debug_traceTransaction', 'debug_traceCall',
    'admin_addPeer', 'admin_removePeer', 'admin_nodeInfo', 'admin_datadir',
    'personal_unlockAccount', 'personal_importRawKey',
]);

async function forwardOne(call: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { method, params = [], id = 1 } = call;

    if (BLOCKED.has(method) || method.startsWith('debug_') || method.startsWith('admin_') || method.startsWith('personal_')) {
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method ${method} is not available` } };
    }

    try {
        const res = await fetch(Config.opnetRpcUrl, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'User-Agent': 'BlockFeed-Proxy/1.0', Accept: 'application/json' },
            body:    JSON.stringify({ jsonrpc: '2.0', method, params, id }),
            signal:  AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!res.ok) return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: `Upstream HTTP ${res.status}` } };
        return res.json() as Promise<JsonRpcResponse>;
    } catch (err: unknown) {
        const e = err as Error;
        const timedOut = e.name === 'TimeoutError' || e.name === 'AbortError';
        return { jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message: timedOut ? 'Upstream timeout' : `Upstream error: ${e.message}` } };
    }
}

export async function handleRpcProxy(
    req: HyperExpress.Request,
    res: HyperExpress.Response,
): Promise<void> {
    incCounter('rpc_proxy_requests_total');

    let body: JsonRpcRequest | JsonRpcRequest[];
    try {
        body = await req.json() as JsonRpcRequest | JsonRpcRequest[];
    } catch {
        res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } });
        return;
    }

    if (Array.isArray(body)) {
        if (body.length === 0) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Empty batch' } }); return; }
        if (body.length > MAX_BATCH) { res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: `Batch max ${MAX_BATCH}` } }); return; }
        const results = await Promise.all(body.map(forwardOne));
        res.json(results);
        return;
    }

    res.json(await forwardOne(body));
}
