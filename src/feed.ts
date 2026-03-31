/**
 * WebSocket stream powered by uWebSockets.js (via @btc-vision/uwebsocket.js).
 *
 * Endpoint: ws://host/v1/stream
 *
 * Client → Server:
 *   { action: 'subscribe',   channel: 'blocks' | 'oracle' | 'events' | 'address' | 'contract' | 'event_type', filter?: string }
 *   { action: 'unsubscribe', channel: ..., filter?: string }
 *   { action: 'ping' }
 *
 * Server → Client:
 *   { type: 'snapshot',    data: BlockData }
 *   { type: 'block',       data: BlockData }
 *   { type: 'oracle_price',data: OracleTick }
 *   { type: 'event',       data: ContractEvent }
 *   { type: 'subscribed',  channels: string[] }
 *   { type: 'pong' }
 *   { type: 'error',       message: string }
 */

import uWS from '@btc-vision/uwebsockets.js';
import type { WsClientSubs, WsClientMsg, WorkerBroadcastMsg } from './types.js';
import { getLatestFee, getLatestBlockActivity } from './db.js';

type UWsApp = ReturnType<typeof uWS.App>;

let app: UWsApp | null = null;

/** userData attached to each socket — holds subscription state. */
interface SocketData {
    subs: WsClientSubs;
}

const VALID_CHANNELS = new Set(['blocks', 'oracle', 'events', 'address', 'contract', 'event_type']);
let connectedClients = 0;

function defaultSubs(): WsClientSubs {
    return {
        blocks:     true,
        oracle:     true,
        events:     false,
        address:    null,
        contract:   null,
        event_type: null,
    };
}

function safeSend(ws: uWS.WebSocket<SocketData>, payload: string): void {
    try {
        ws.send(payload, false, false);
    } catch {
        /* closed socket */
    }
}

function handleClientMsg(ws: uWS.WebSocket<SocketData>, raw: ArrayBuffer): void {
    let msg: WsClientMsg;
    try {
        msg = JSON.parse(new TextDecoder().decode(raw)) as WsClientMsg;
    } catch {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
    }

    const { action } = msg;

    if (action === 'ping') {
        safeSend(ws, JSON.stringify({ type: 'pong' }));
        return;
    }

    if (action !== 'subscribe' && action !== 'unsubscribe') {
        safeSend(ws, JSON.stringify({ type: 'error', message: 'Unknown action' }));
        return;
    }

    const { channel, filter } = msg;
    if (!VALID_CHANNELS.has(channel)) {
        safeSend(ws, JSON.stringify({ type: 'error', message: `Unknown channel: ${channel}` }));
        return;
    }

    const data = ws.getUserData();
    const subs = data.subs;

    if (action === 'subscribe') {
        if (channel === 'events') {
            subs.events = true;
        } else if (channel === 'address' || channel === 'contract' || channel === 'event_type') {
            if (typeof filter !== 'string' || filter.length < 2) {
                safeSend(ws, JSON.stringify({ type: 'error', message: 'filter required' }));
                return;
            }
            if (!subs[channel]) subs[channel] = new Set<string>();
            subs[channel]!.add(filter.toLowerCase());
        }
    } else {
        if (channel === 'events') {
            subs.events = false;
        } else if (channel === 'address' || channel === 'contract' || channel === 'event_type') {
            if (filter && subs[channel]) {
                subs[channel]!.delete(filter.toLowerCase());
                if (subs[channel]!.size === 0) subs[channel] = null;
            } else {
                subs[channel] = null;
            }
        }
    }

    const active: string[] = ['blocks', 'oracle'];
    if (subs.events) active.push('events');
    if (subs.address?.size)    active.push(`address:${[...subs.address].join(',')}`);
    if (subs.contract?.size)   active.push(`contract:${[...subs.contract].join(',')}`);
    if (subs.event_type?.size) active.push(`event_type:${[...subs.event_type].join(',')}`);

    safeSend(ws, JSON.stringify({ type: 'subscribed', channels: active }));
}

export function startFeed(uwsApp: UWsApp): void {
    app = uwsApp;

    uwsApp.ws<SocketData>('/v1/stream', {
        compression:   uWS.SHARED_COMPRESSOR,
        maxPayloadLength: 16 * 1024,
        idleTimeout:   120,

        upgrade: (res, req, context) => {
            res.upgrade<SocketData>(
                { subs: defaultSubs() },
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context,
            );
        },

        open: (ws) => {
            connectedClients++;
            console.log(`[Feed] Client connected (${connectedClients} total)`);
            // Send snapshot of current state immediately on connect
            Promise.all([getLatestFee(), getLatestBlockActivity()]).then(([fee, blk]) => {
                if (!fee) return;
                const snap = JSON.stringify({
                    type: 'snapshot',
                    data: {
                        block:   blk?.block_height ?? fee.block_height,
                        fee:     fee.median_fee_scaled,
                        mempool: fee.mempool_count,
                        ts:      fee.submitted_at,
                    },
                });
                safeSend(ws, snap);
            }).catch(() => { /* ignore */ });
        },

        message: (ws, message) => {
            handleClientMsg(ws, message);
        },

        close: (_ws) => {
            connectedClients = Math.max(0, connectedClients - 1);
            console.log(`[Feed] Client disconnected (${connectedClients} remaining)`);
        },
    });

    console.log('[Feed] WebSocket stream ready at /v1/stream');
}

export function getConnectedClients(): number {
    return connectedClients;
}

/** Push a live block/fee update to all connected clients. */
export function broadcastBlock(block: number, fee: number, mempool: number, ts: Date): void {
    if (!app) return;
    const payload = JSON.stringify({ type: 'block', data: { block, fee, mempool, ts } });
    app.publish('broadcast:all', payload, false, false);
}

/**
 * Broadcast from the main thread.
 * Called by worker message handler when a worker sends {type:'broadcast',...}.
 */
export function broadcast(msg: WorkerBroadcastMsg): void {
    if (!app) return;
    const { event: eventType, data } = msg;
    const payload = JSON.stringify({ type: eventType, data });

    app.publish('broadcast:all', payload, false, false);

    if (eventType === 'event') {
        const ev = data as { from_address?: string; contract_address?: string; event_type?: string };
        const from     = (ev.from_address ?? '').toLowerCase();
        const contract = (ev.contract_address ?? '').toLowerCase();
        const evType   = (ev.event_type ?? '').toLowerCase();

        if (from)     app.publish(`broadcast:address:${from}`,         payload, false, false);
        if (contract) app.publish(`broadcast:contract:${contract}`,    payload, false, false);
        if (evType)   app.publish(`broadcast:event_type:${evType}`,    payload, false, false);
    }
}
