/**
 * Token metadata fetcher.
 *
 * Calls OPNet via btc_call with SHA256-derived method selectors.
 * OPNet OP20 ABI encoding:
 *   - Selector: first 4 bytes of SHA256(methodName+"()")
 *   - String return: 4-byte LE length prefix + UTF-8 bytes
 *   - uint8 return (decimals): 1 byte
 *   - uint256 return (totalSupply): 32 bytes big-endian
 */

import crypto from 'crypto';
import { pool } from './db.js';

const OPNET_RPC = process.env['OPNET_RPC_URL'] ?? 'https://testnet.opnet.org/api/v1/json-rpc';
const TIMEOUT   = 12_000;

// ── Selector computation ──────────────────────────────────────────────────────

function selector(method: string): string {
    const hash = crypto.createHash('sha256').update(method + '()').digest();
    return '0x' + hash.slice(0, 4).toString('hex');
}

const SEL = {
    symbol:      selector('symbol'),
    name:        selector('name'),
    decimals:    selector('decimals'),
    totalSupply: selector('totalSupply'),
};

// ── RPC call ──────────────────────────────────────────────────────────────────

interface BtcCallResult {
    result?: string;   // base64 encoded return value
    revert?: string;   // base64 encoded revert message — present on failure
}

async function btcCall(contractAddress: string, calldata: string): Promise<Buffer | null> {
    try {
        const res = await fetch(OPNET_RPC, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                jsonrpc: '2.0',
                method:  'btc_call',
                params:  { to: contractAddress, calldata },
                id:      1,
            }),
            signal: AbortSignal.timeout(TIMEOUT),
        });
        if (!res.ok) return null;
        const json = await res.json() as { result?: BtcCallResult };
        const r = json.result;
        if (!r || r.revert || !r.result) return null;
        return Buffer.from(r.result, 'base64');
    } catch {
        return null;
    }
}

// ── Decoders ──────────────────────────────────────────────────────────────────

/** Decode a string: 4-byte LE length prefix + UTF-8 bytes */
function decodeString(buf: Buffer): string | null {
    if (!buf || buf.length < 4) return null;
    const len = buf.readUInt32BE(0);
    if (buf.length < 4 + len || len === 0 || len > 256) return null;
    const str = buf.slice(4, 4 + len).toString('utf8');
    // Sanity check: printable ASCII/Unicode only
    if (!/^[\x20-\x7e\u0080-\uFFFF]+$/.test(str)) return null;
    return str;
}

/** Decode uint8 (decimals): single byte */
function decodeUint8(buf: Buffer): number | null {
    if (!buf || buf.length < 1) return null;
    const v = buf[0]!;
    if (v > 18) return null; // sanity: decimals > 18 is not normal
    return v;
}

/** Decode uint256 (totalSupply): 32 bytes big-endian as decimal string */
function decodeUint256(buf: Buffer): string | null {
    if (!buf || buf.length < 32) return null;
    const hex = buf.slice(buf.length - 32).toString('hex');
    return BigInt('0x' + hex).toString(10);
}

// ── Public API ────────────────────────────────────────────────────────────────

interface TokenMetadata {
    name?:        string;
    symbol?:      string;
    decimals?:    number;
    totalSupply?: string;
}

export async function fetchAndStoreTokenMetadata(contractAddress: string): Promise<void> {
    try {
        const [symBuf, nameBuf, decBuf, supBuf] = await Promise.all([
            btcCall(contractAddress, SEL.symbol),
            btcCall(contractAddress, SEL.name),
            btcCall(contractAddress, SEL.decimals),
            btcCall(contractAddress, SEL.totalSupply),
        ]);

        const meta: TokenMetadata = {
            symbol:      symBuf  ? decodeString(symBuf)   ?? undefined : undefined,
            name:        nameBuf ? decodeString(nameBuf)  ?? undefined : undefined,
            decimals:    decBuf  ? decodeUint8(decBuf)    ?? undefined : undefined,
            totalSupply: supBuf  ? decodeUint256(supBuf)  ?? undefined : undefined,
        };

        if (!meta.symbol && !meta.name) {
            // Not an OP20 — mark as failed so we don't retry forever
            await pool.query(
                `UPDATE tokens SET fetch_status = 'not_op20', fetched_at = NOW() WHERE contract_address = $1`,
                [contractAddress],
            );
            return;
        }

        await pool.query(
            `UPDATE tokens
             SET name         = COALESCE($1, name),
                 symbol       = COALESCE($2, symbol),
                 decimals     = COALESCE($3, decimals),
                 total_supply = COALESCE($4, total_supply),
                 fetch_status = 'fetched',
                 fetched_at   = NOW()
             WHERE contract_address = $5`,
            [meta.name ?? null, meta.symbol ?? null, meta.decimals ?? null, meta.totalSupply ?? null, contractAddress],
        );
    } catch {
        await pool.query(
            `UPDATE tokens SET fetch_status = 'failed', fetched_at = NOW() WHERE contract_address = $1`,
            [contractAddress],
        ).catch(() => undefined);
    }
}

/**
 * Backfill: fetch metadata for all contracts still in 'pending' status.
 * Runs at startup with concurrency limiting so it doesn't hammer the RPC.
 */
export async function backfillTokenMetadata(): Promise<void> {
    const { rows } = await pool.query<{ contract_address: string }>(
        `SELECT contract_address FROM tokens
         WHERE fetch_status IN ('pending', 'failed')
         ORDER BY contract_address`,
    );

    if (rows.length === 0) return;

    console.log(`[TokenFetcher] Backfilling ${rows.length} pending tokens…`);

    const CONCURRENCY = 5;
    for (let i = 0; i < rows.length; i += CONCURRENCY) {
        const batch = rows.slice(i, i + CONCURRENCY);
        await Promise.allSettled(batch.map(r => fetchAndStoreTokenMetadata(r.contract_address)));
        // Small delay between batches to avoid rate-limiting
        if (i + CONCURRENCY < rows.length) await new Promise(r => setTimeout(r, 300));
    }

    const { rows: fetched } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE fetch_status = 'fetched')::int AS ok,
                COUNT(*) FILTER (WHERE fetch_status = 'not_op20')::int AS skipped,
                COUNT(*) FILTER (WHERE fetch_status = 'failed')::int   AS failed
         FROM tokens`,
    );
    const s = fetched[0];
    console.log(`[TokenFetcher] Backfill done — fetched: ${s?.ok}, not_op20: ${s?.skipped}, failed: ${s?.failed}`);
}
