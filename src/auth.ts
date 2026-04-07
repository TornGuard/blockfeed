/**
 * Wallet-based authentication for BlockFeed.
 *
 * Flow:
 *  1. POST /v1/auth/nonce  {wallet}          → {nonce}
 *  2. POST /v1/auth/verify {wallet, nonce, signature} → {token, apiKey}
 *  3. GET  /v1/auth/me     X-Session-Token   → {wallet, apiKey}
 *  4. POST /v1/auth/logout X-Session-Token   → {ok}
 *
 * Signature verification:
 *  - UniSat / OPNet wallets sign via window.unisat.signMessage(nonce)
 *  - Returns base64 ECDSA (BIP-137) or Schnorr signature
 *  - We verify using bitcoinjs-message (BIP-137) with fallback to raw Schnorr
 */

import crypto from 'crypto';
import HyperExpress from '@btc-vision/hyper-express';
import bitcoinMessage from 'bitcoinjs-message';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { bech32m } from 'bech32';
import {
    upsertNonce, consumeNonce, upsertUser,
    createSession, lookupSession, deleteSession,
    getOrCreateUserApiKey,
} from './db.js';

type Req = HyperExpress.Request;
type Res = HyperExpress.Response;

function tokenHash(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

function generateNonce(): string {
    return crypto.randomBytes(16).toString('hex');
}

function generateToken(): string {
    return crypto.randomBytes(32).toString('hex');
}

/** BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg) */
function taggedHash(tag: string, msg: Uint8Array): Uint8Array {
    const tagBytes = Buffer.from(tag, 'utf8');
    const tagHash = sha256(tagBytes);
    return sha256(Buffer.concat([tagHash, tagHash, msg]));
}

/** BIP-137 / Bitcoin message magic hash: SHA256d("\x18Bitcoin Signed Message:\n" + varint(len) + msg) */
function bitcoinMagicHash(message: string): Uint8Array {
    const msgBytes = Buffer.from(message, 'utf8');
    const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'utf8');
    // varint for message length
    const len = msgBytes.length;
    const lenBuf = len < 253 ? Buffer.from([len]) : Buffer.concat([Buffer.from([0xfd]), Buffer.from([len & 0xff, (len >> 8) & 0xff])]);
    const payload = Buffer.concat([prefix, lenBuf, msgBytes]);
    return sha256(sha256(payload));
}

/** All message hash candidates to try */
function allMessageHashes(message: string): Array<{ label: string; hash: Uint8Array }> {
    const msgBytes = Buffer.from(message, 'utf8');
    return [
        { label: 'bip322-tagged',   hash: taggedHash('BIP0322-signed-message', msgBytes) },
        { label: 'bitcoin-magic',   hash: bitcoinMagicHash(message) },
        { label: 'sha256',          hash: sha256(msgBytes) },
        { label: 'sha256d',         hash: sha256(sha256(msgBytes)) },
        { label: 'tagged-challenge',hash: taggedHash('BIP0322-signed-message\n', msgBytes) },
    ];
}

/** Decode a bech32m address (any HRP) → x-only pubkey (32 bytes) or null */
function decodeBech32mPubkey(address: string): Uint8Array | null {
    try {
        const decoded = bech32m.decode(address, 1000);
        const program = new Uint8Array(bech32m.fromWords(decoded.words.slice(1)));
        if (program.length === 32) return program;
        return null;
    } catch { return null; }
}

/** Try all known Taproot/OPNet signature formats × all known message hashes */
function verifyTaprootSig(address: string, message: string, sigBase64: string): boolean {
    const sigBuf = Buffer.from(sigBase64, 'base64');
    const addrPubkey = decodeBech32mPubkey(address);
    const hashes = allMessageHashes(message);

    console.log('[taproot] addrPubkey:', addrPubkey ? Buffer.from(addrPubkey).toString('hex').slice(0, 16) + '...' : 'null');
    console.log('[taproot] sig len:', sigBuf.length, 'hex:', sigBuf.toString('hex').slice(0, 32) + '...');

    // Candidate [sig, pubkey] pairs to try
    const candidates: Array<{ sig: Uint8Array; pub: Uint8Array; label: string }> = [];

    if (addrPubkey) {
        // Try every 64-byte window with the address pubkey
        for (let i = 0; i <= sigBuf.length - 64; i++) {
            candidates.push({ sig: sigBuf.slice(i, i + 64), pub: addrPubkey, label: `offset${i}+addrPub` });
        }
    }

    // If 96 bytes: try [pub32][sig64] and [sig64][pub32]
    if (sigBuf.length === 96) {
        candidates.push({ sig: sigBuf.slice(32, 96), pub: sigBuf.slice(0, 32),  label: 'pub32+sig64' });
        candidates.push({ sig: sigBuf.slice(0,  64), pub: sigBuf.slice(64, 96), label: 'sig64+pub32' });
    }

    for (const { sig, pub, label } of candidates) {
        for (const { label: hashLabel, hash } of hashes) {
            try {
                if (schnorr.verify(sig, hash, pub)) {
                    console.log(`[taproot] MATCH: sig=${label} hash=${hashLabel}`);
                    return true;
                }
            } catch { /* skip */ }
        }
    }

    console.log('[taproot] no combination matched');

    // Last resort: try ECDSA recovery for all hash types
    if (sigBuf.length >= 65) {
        for (const { label: hashLabel, hash } of hashes) {
            for (let recId = 0; recId < 4; recId++) {
                try {
                    // Try treating first 64 bytes as compact r,s
                    const r = BigInt('0x' + sigBuf.slice(0, 32).toString('hex'));
                    const s = BigInt('0x' + sigBuf.slice(32, 64).toString('hex'));
                    const sig = new secp256k1.Signature(r, s);
                    const recovered = sig.addRecoveryBit(recId).recoverPublicKey(hash);
                    const xonly = recovered.toRawBytes(true).slice(1); // x-only
                    if (addrPubkey && Buffer.from(xonly).equals(Buffer.from(addrPubkey))) {
                        console.log(`[taproot] ECDSA MATCH: hash=${hashLabel} recId=${recId}`);
                        return true;
                    }
                } catch { /* skip */ }
            }
        }
        console.log('[taproot] ECDSA recovery: no match');
    }

    return false;
}

/** Verify a Bitcoin message signature — handles BIP-137 (legacy/segwit) and BIP-322 (Taproot) */
function verifyBitcoinSig(address: string, nonce: string, signature: string): boolean {
    const message = buildSignMessage(nonce);
    const isTaproot = /^(bc1p|tb1p|opt1)/i.test(address);

    if (isTaproot) {
        return verifyTaprootSig(address, message, signature);
    }

    // BIP-137 ECDSA for legacy / P2SH / P2WPKH
    try {
        return bitcoinMessage.verify(message, address, signature, undefined, true);
    } catch {
        try {
            return bitcoinMessage.verify(message, address, signature);
        } catch {
            return false;
        }
    }
}

/** The message that gets signed — include nonce so it's human-readable */
export function buildSignMessage(nonce: string): string {
    return `Sign in to BlockFeed\n\nNonce: ${nonce}`;
}

export function registerAuthRoutes(app: HyperExpress.Server): void {

    // ── POST /v1/auth/nonce ────────────────────────────────────────────────────
    app.post('/v1/auth/nonce', async (req: Req, res: Res) => {
        try {
            const body = await req.json() as { wallet?: string };
            const wallet = body.wallet?.trim();
            if (!wallet) { res.status(400).json({ error: 'wallet required' }); return; }

            const nonce = generateNonce();
            await upsertNonce(wallet, nonce);

            res.json({
                ok: true,
                nonce,
                message: buildSignMessage(nonce),
            });
        } catch (err) {
            console.error('[auth/nonce]', (err as Error).message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── POST /v1/auth/verify ───────────────────────────────────────────────────
    app.post('/v1/auth/verify', async (req: Req, res: Res) => {
        try {
            const body = await req.json() as { wallet?: string; nonce?: string; signature?: string };
            const { wallet, nonce, signature } = body;

            if (!wallet || !nonce || !signature) {
                res.status(400).json({ error: 'wallet, nonce and signature required' });
                return;
            }

            // Verify signature first (before consuming nonce to avoid timing attacks)
            const message = buildSignMessage(nonce);
            const sigBuf = Buffer.from(signature, 'base64');
            const isTaproot = /^(bc1p|tb1p|opt1)/i.test(wallet);
            console.log('[auth/verify] wallet:', wallet);
            console.log('[auth/verify] isTaproot:', isTaproot);
            console.log('[auth/verify] message:', JSON.stringify(message));
            console.log('[auth/verify] sig base64 len:', signature.length, 'buf len:', sigBuf.length);
            console.log('[auth/verify] sig first bytes:', sigBuf.slice(0, 8).toString('hex'));
            let bip137Result = false;
            try { bip137Result = bitcoinMessage.verify(message, wallet, signature, undefined, true); } catch (e: any) { console.log('[auth/verify] bip137 error:', e.message); }
            console.log('[auth/verify] bip137 result:', bip137Result);
            const valid = verifyBitcoinSig(wallet, nonce, signature);
            console.log('[auth/verify] final result:', valid);
            if (!valid) {
                res.status(401).json({ error: 'Invalid signature' });
                return;
            }

            // Consume nonce (one-time use)
            const consumed = await consumeNonce(wallet, nonce);
            if (!consumed) {
                res.status(401).json({ error: 'Nonce expired or already used' });
                return;
            }

            // Upsert user
            const user = await upsertUser(wallet);

            // Get or create API key for this user
            const { rawKey } = await getOrCreateUserApiKey(user.id, wallet);

            // Create session
            const rawToken = generateToken();
            await createSession(user.id, tokenHash(rawToken));

            res.json({
                ok: true,
                token: rawToken,
                // Only send rawKey on first creation (empty string means key already existed)
                apiKey: rawKey || null,
                wallet: user.wallet_address,
            });
        } catch (err) {
            console.error('[auth/verify]', (err as Error).message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── GET /v1/auth/me ────────────────────────────────────────────────────────
    app.get('/v1/auth/me', async (req: Req, res: Res) => {
        try {
            const raw = req.headers['x-session-token'] ?? '';
            if (!raw) { res.status(401).json({ error: 'x-session-token required' }); return; }

            const session = await lookupSession(tokenHash(raw));
            if (!session) { res.status(401).json({ error: 'Invalid or expired session' }); return; }

            res.json({
                ok: true,
                wallet: session.wallet_address,
                hasApiKey: !!session.api_key_hash,
            });
        } catch (err) {
            console.error('[auth/me]', (err as Error).message);
            res.status(500).json({ error: 'Internal error' });
        }
    });

    // ── POST /v1/auth/logout ───────────────────────────────────────────────────
    app.post('/v1/auth/logout', async (req: Req, res: Res) => {
        try {
            const raw = req.headers['x-session-token'] ?? '';
            if (raw) await deleteSession(tokenHash(raw));
            res.json({ ok: true });
        } catch {
            res.json({ ok: true }); // Always succeed
        }
    });
}

/** Middleware: resolve session token → key_id for webhook routes */
export async function resolveSession(req: Req, _res: Res): Promise<string | null> {
    const raw = req.headers['x-session-token'] ?? '';
    if (!raw) return null;
    try {
        const session = await lookupSession(tokenHash(raw));
        if (!session?.api_key_hash) return null;
        // Return the user_id so webhooks are tied to the user
        return session.user_id;
    } catch {
        return null;
    }
}
