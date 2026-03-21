/**
 * Fetches OP_20 token metadata via OPNet RPC.
 * Uses the metadata() selector (0x45447b7a) which returns:
 *   name(string) + symbol(string) + icon(string) + decimals(u8) + totalSupply(u256) + domainSeparator(bytes32)
 *
 * OPNet BinaryReader wire format:
 *   string  → u16 BE length prefix + UTF-8 bytes
 *   uint8   → 1 byte
 *   uint256 → 32 bytes big-endian
 *   bytes32 → 32 bytes
 */

import { ABICoder } from '@btc-vision/transaction';
import { updateTokenMetadata } from './db.js';

const OPNET_RPC       = 'https://testnet.opnet.org/api/v1/json-rpc';
const coder           = new ABICoder();
const METADATA_SEL    = '0x' + coder.encodeSelector('metadata');

// ── Low-level RPC call (returns full response body, not just .result) ─────────
async function callContract(to, data) {
  const res = await fetch(OPNET_RPC, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'BlockFeed/1.0' },
    body:    JSON.stringify({ jsonrpc: '2.0', method: 'eth_call', params: [{ to, data }, 'latest'], id: 1 }),
    signal:  AbortSignal.timeout(10_000),
  });
  return res.json();
}

// ── Decode OPNet BinaryReader response ────────────────────────────────────────
function decodeMetadataResponse(resultB64) {
  try {
    const buf = Buffer.from(resultB64, 'base64');
    if (buf.length < 4) return null;

    let offset = 0;

    function readString() {
      if (offset + 2 > buf.length) throw new Error('buffer underflow (string len)');
      const len = buf.readUInt16BE(offset);
      offset += 2;
      if (offset + len > buf.length) throw new Error('buffer underflow (string data)');
      const str = buf.subarray(offset, offset + len).toString('utf8');
      offset += len;
      return str;
    }

    function readU8() {
      if (offset >= buf.length) throw new Error('buffer underflow (u8)');
      return buf[offset++];
    }

    function readU256() {
      if (offset + 32 > buf.length) throw new Error('buffer underflow (u256)');
      const val = BigInt('0x' + buf.subarray(offset, offset + 32).toString('hex'));
      offset += 32;
      return val.toString();
    }

    const name        = readString();
    const symbol      = readString();
    const icon        = readString();
    const decimals    = readU8();
    const total_supply = readU256();

    if (!name && !symbol) return null; // likely not a token

    return {
      name:         name  || null,
      symbol:       symbol || null,
      icon:         icon  || null,
      decimals,
      total_supply,
      fetch_status: 'done',
    };
  } catch {
    return null;
  }
}

// ── Public: fetch and persist metadata for one contract ───────────────────────
export async function fetchAndStoreTokenMetadata(contractAddress) {
  try {
    const body = await callContract(contractAddress, METADATA_SEL);

    // Reverted or errored → not an OP_20 token (or old runtime)
    if (body.result?.revert || !body.result?.result || body.result.result === 'AA==') {
      await updateTokenMetadata(contractAddress, { fetch_status: 'failed' });
      return;
    }

    const meta = decodeMetadataResponse(body.result.result);
    if (!meta) {
      await updateTokenMetadata(contractAddress, { fetch_status: 'failed' });
      return;
    }

    await updateTokenMetadata(contractAddress, meta);
    console.log(`[Tokens] ${contractAddress.slice(0, 10)}… → ${meta.symbol || '?'} (${meta.name || '?'})`);
  } catch (e) {
    // Non-fatal — mark failed and move on
    try { await updateTokenMetadata(contractAddress, { fetch_status: 'failed' }); } catch { /* */ }
    console.warn(`[Tokens] Metadata fetch failed for ${contractAddress.slice(0, 10)}…:`, e.message);
  }
}
