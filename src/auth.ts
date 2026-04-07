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
import { schnorr } from '@noble/curves/secp256k1';
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

/**
 * BIP-322 tagged hash for message signing.
 * tag = "BIP0322-signed-message"
 * hash = SHA256(SHA256(tag) || SHA256(tag) || msg)
 */
function bip322MessageHash(message: string): Uint8Array {
    const tag = Buffer.from('BIP0322-signed-message', 'utf8');
    const tagHash = sha256(tag);
    const msgBytes = Buffer.from(message, 'utf8');
    return sha256(Buffer.concat([tagHash, tagHash, msgBytes]));
}

/** Decode a bech32m address (any HRP) → x-only pubkey (32 bytes) or null */
function decodeBech32mPubkey(address: string): Uint8Array | null {
    try {
        const decoded = bech32m.decode(address, 1000);
        const program = new Uint8Array(bech32m.fromWords(decoded.words.slice(1)));
        console.log('[taproot] address HRP:', decoded.prefix, 'program len:', program.length, 'bytes:', Buffer.from(program).toString('hex').slice(0, 16) + '...');
        if (program.length === 32) return program;
        return null;
    } catch (e: any) {
        console.log('[taproot] bech32m decode error:', e.message);
        return null;
    }
}

/**
 * Try all known Taproot/OPNet signature formats and log which succeeds.
 */
function verifyTaprootSig(address: string, message: string, sigBase64: string): boolean {
    const sigBuf = Buffer.from(sigBase64, 'base64');
    const msgHash = bip322MessageHash(message);
    const addrPubkey = decodeBech32mPubkey(address);

    console.log('[taproot] sig len:', sigBuf.length, 'msgHash:', Buffer.from(msgHash).toString('hex').slice(0, 16) + '...');

    const tryVerify = (label: string, sig: Uint8Array, pub: Uint8Array): boolean => {
        try {
            const ok = schnorr.verify(sig, msgHash, pub);
            console.log(`[taproot] attempt ${label}:`, ok);
            return ok;
        } catch (e: any) {
            console.log(`[taproot] attempt ${label} error:`, e.message);
            return false;
        }
    };

    // 1. Raw 64-byte Schnorr sig + pubkey from address
    if (sigBuf.length === 64 && addrPubkey) {
        if (tryVerify('raw64+addrPubkey', sigBuf, addrPubkey)) return true;
    }

    // 2. BIP-322 simple [01 40 <64>]
    if (sigBuf.length >= 66 && sigBuf[0] === 0x01 && sigBuf[1] === 0x40 && addrPubkey) {
        if (tryVerify('bip322simple', sigBuf.slice(2, 66), addrPubkey)) return true;
    }

    // 3. [32-byte pubkey][64-byte Schnorr sig] — OPNet custom format
    if (sigBuf.length === 96) {
        const pub32 = sigBuf.slice(0, 32);
        const sig64 = sigBuf.slice(32, 96);
        if (tryVerify('pub32+sig64', sig64, pub32)) return true;

        // Also try reversed: [64-byte sig][32-byte pubkey]
        const sig64b = sigBuf.slice(0, 64);
        const pub32b = sigBuf.slice(64, 96);
        if (tryVerify('sig64+pub32', sig64b, pub32b)) return true;

        // Try with address pubkey
        if (addrPubkey) {
            if (tryVerify('sig64_from32_addrPubkey', sigBuf.slice(32, 96), addrPubkey)) return true;
            if (tryVerify('sig64_from0_addrPubkey',  sigBuf.slice(0,  64), addrPubkey)) return true;
        }
    }

    // 4. Try all 33 possible 64-byte windows (brute force offset) with address pubkey
    if (addrPubkey && sigBuf.length >= 64) {
        for (let i = 0; i <= sigBuf.length - 64; i++) {
            try {
                const ok = schnorr.verify(sigBuf.slice(i, i + 64), msgHash, addrPubkey);
                if (ok) { console.log(`[taproot] brute offset=${i} matched!`); return true; }
            } catch { /* skip */ }
        }
        console.log('[taproot] brute force: no offset matched');
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
