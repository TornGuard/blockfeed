/**
 * Token metadata fetcher.
 * Calls OPNet RPC to populate name/symbol/decimals/totalSupply for new OP20 tokens.
 */

import { pool } from './db.js';

const OPNET_RPC = process.env['OPNET_RPC_URL'] ?? 'https://testnet.opnet.org';
const TIMEOUT   = 10_000;

interface TokenMetadata {
    name?: string;
    symbol?: string;
    decimals?: number;
    totalSupply?: string;
}

async function callOpnet(contractAddress: string, method: string): Promise<unknown> {
    const res = await fetch(`${OPNET_RPC}/api/v1/contract/${contractAddress}/call`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ method, params: [] }),
        signal:  AbortSignal.timeout(TIMEOUT),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

export async function fetchAndStoreTokenMetadata(contractAddress: string): Promise<void> {
    try {
        const meta: TokenMetadata = {};

        const [nameRes, symbolRes, decimalsRes, supplyRes] = await Promise.allSettled([
            callOpnet(contractAddress, 'name'),
            callOpnet(contractAddress, 'symbol'),
            callOpnet(contractAddress, 'decimals'),
            callOpnet(contractAddress, 'totalSupply'),
        ]);

        if (nameRes.status    === 'fulfilled') meta.name        = (nameRes.value    as { result?: string }).result;
        if (symbolRes.status  === 'fulfilled') meta.symbol      = (symbolRes.value  as { result?: string }).result;
        if (decimalsRes.status === 'fulfilled') meta.decimals   = Number((decimalsRes.value as { result?: string }).result ?? 8);
        if (supplyRes.status  === 'fulfilled') meta.totalSupply = String((supplyRes.value  as { result?: string }).result ?? '0');

        if (!meta.symbol && !meta.name) return; // not an OP20

        await pool.query(
            `UPDATE tokens
             SET name = COALESCE($1, name),
                 symbol = COALESCE($2, symbol),
                 decimals = COALESCE($3, decimals),
                 total_supply = COALESCE($4, total_supply),
                 fetch_status = 'fetched',
                 fetched_at = NOW()
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
