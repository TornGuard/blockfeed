/**
 * Oracle public key accessor for the main thread.
 *
 * The oracle worker signs prices with an ed25519 key.
 * This module exposes the public key so the /v1/oracle/pubkey endpoint
 * can serve it without spawning a child process.
 *
 * The oracle-worker.ts is the canonical source of price data.
 * This file holds only the shared signing setup for the main thread's pubkey route.
 */

import crypto from 'crypto';

let _pubKeyDer = '';

export function initOracleKeys(): void {
    const raw = process.env['ORACLE_PRIVATE_KEY'];
    let privateKey: crypto.KeyObject;

    if (raw) {
        try {
            privateKey = crypto.createPrivateKey({
                key:    Buffer.from(raw, 'base64'),
                format: 'der',
                type:   'pkcs8',
            });
        } catch {
            const { privateKey: pk } = crypto.generateKeyPairSync('ed25519');
            privateKey = pk;
        }
    } else {
        const { privateKey: pk } = crypto.generateKeyPairSync('ed25519');
        privateKey = pk;
    }

    const pub = crypto.createPublicKey(privateKey);
    _pubKeyDer = pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function getOraclePubKey(): string { return _pubKeyDer; }
