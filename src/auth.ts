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


/** Decode a bech32m address (any HRP) → x-only pubkey (32 bytes) or null */
function decodeBech32mPubkey(address: string): Uint8Array | null {
    try {
        const decoded = bech32m.decode(address, 1000);
        const program = new Uint8Array(bech32m.fromWords(decoded.words.slice(1)));
        if (program.length === 32) return program;
        return null;
    } catch { return null; }
}

/**
 * Verify an OPNet/Taproot Schnorr signature.
 * OPNet uses: sig = schnorr.sign(SHA256(message), privateKey) → 64 bytes → base64
 * Verification: schnorr.verify(sig, SHA256(message), xonly_pubkey_from_address)
 */
function verifyTaprootSig(address: string, message: string, sigBase64: string): boolean {
    try {
        const sigBuf = Buffer.from(sigBase64, 'base64');
        console.log('[taproot] sig len:', sigBuf.length, 'hex:', sigBuf.slice(0, 8).toString('hex'));
        if (sigBuf.length !== 64) {
            console.log('[taproot] unexpected sig length:', sigBuf.length, '(expected 64)');
            return false;
        }

        const addrPubkey = decodeBech32mPubkey(address);
        if (!addrPubkey) {
            console.log('[taproot] could not decode address pubkey');
            return false;
        }

        // OPNet MessageSigner: hash = SHA256(message_bytes), then BIP-340 Schnorr
        const msgHash = sha256(Buffer.from(message, 'utf-8'));
        const ok = schnorr.verify(sigBuf, msgHash, addrPubkey);
        console.log('[taproot] verify result:', ok);
        return ok;
    } catch (e: any) {
        console.log('[taproot] error:', e.message);
        return false;
    }
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
            const valid = verifyBitcoinSig(wallet, nonce, signature);
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
