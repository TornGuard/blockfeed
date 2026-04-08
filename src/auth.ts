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
import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@btc-vision/post-quantum/ml-dsa.js';
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


/** Decode a bech32m address (any HRP) → 32-byte witness program or null */
function decodeBech32mProgram(address: string): Uint8Array | null {
    try {
        const decoded = bech32m.decode(address, 1000);
        const program = new Uint8Array(bech32m.fromWords(decoded.words.slice(1)));
        return program.length === 32 ? program : null;
    } catch { return null; }
}

/** Pick ML-DSA variant by securityLevel number (44, 65, 87) */
function mlDsaForLevel(level: number) {
    if (level === 65) return ml_dsa65;
    if (level === 87) return ml_dsa87;
    return ml_dsa44; // default LEVEL2 = 44
}

/**
 * Verify an OPNet ML-DSA (post-quantum) signature.
 * sigBase64 = base64(JSON({ type:'mldsa', signature, publicKey, securityLevel }))
 *
 * 1. SHA256(publicKey) == bech32m witness program → proves key owns address
 * 2. ml_dsa.verify(sig, SHA256(message), pubKey)  → proves they signed
 */
function verifyOPNetSig(address: string, message: string, sigBase64: string): boolean {
    try {
        const json = JSON.parse(Buffer.from(sigBase64, 'base64').toString('utf-8'));
        if (json.type !== 'mldsa') return false;

        const pubKeyBytes = Buffer.from(json.publicKey,  'hex');
        const sigBytes    = Buffer.from(json.signature,  'hex');
        const level       = Number(json.securityLevel) || 44;

        console.log('[opnet] address:', address);
        console.log('[opnet] level:', level, 'pubLen:', pubKeyBytes.length, 'sigLen:', sigBytes.length);

        // 1. Verify publicKey hashes to the address witness program
        const addrProgram = decodeBech32mProgram(address);
        if (!addrProgram) { console.log('[opnet] bad address — decodeBech32mProgram returned null'); return false; }

        const pubKeyHash  = sha256(pubKeyBytes);
        console.log('[opnet] addrProgram (hex):', Buffer.from(addrProgram).toString('hex'));
        console.log('[opnet] sha256(pubKey) (hex):', Buffer.from(pubKeyHash).toString('hex'));
        const hashMatches = Buffer.from(pubKeyHash).equals(Buffer.from(addrProgram));
        console.log('[opnet] hashMatches:', hashMatches);
        if (!hashMatches) return false;

        // 2. Verify ML-DSA signature — message is already SHA256'd by client before wallet signs
        const msgHash = sha256(Buffer.from(message, 'utf-8'));
        console.log('[opnet] message:', message);
        console.log('[opnet] sha256(message) (hex):', Buffer.from(msgHash).toString('hex'));
        const dsa = mlDsaForLevel(level);
        const ok = dsa.verify(sigBytes, msgHash, pubKeyBytes);
        console.log('[opnet] ml_dsa verify:', ok);
        return ok;
    } catch (e: any) {
        console.log('[opnet] error:', e.message);
        return false;
    }
}

/** Verify a Bitcoin message signature — handles BIP-137, BIP-322, and OPNet ML-DSA */
function verifyBitcoinSig(address: string, nonce: string, signature: string): boolean {
    const message = buildSignMessage(nonce);
    const isOPNet   = /^(op1|opt1|opr1)/i.test(address);  // OPNet addresses (mainnet/testnet/regtest)
    const isTaproot = /^(bc1p|tb1p)/i.test(address);

    if (isOPNet) {
        return verifyOPNetSig(address, message, signature);
    }

    if (isTaproot) {
        // BIP-322 simple for standard Bitcoin Taproot
        try {
            const sigBuf = Buffer.from(signature, 'base64');
            const program = decodeBech32mProgram(address);
            if (!program || sigBuf.length !== 64) return false;
            const msgHash = sha256(Buffer.from(message, 'utf-8'));
            return schnorr.verify(sigBuf, msgHash, program);
        } catch { return false; }
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
