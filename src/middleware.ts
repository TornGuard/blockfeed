/**
 * Auth + rate limiting middleware for BlockFeed.
 *
 * - Public endpoints: no key required, 120 req/min per IP
 * - API key tier: key in X-Api-Key header, custom rate limit per key
 * - Admin endpoints: X-Admin-Key header must match ADMIN_KEY env var
 */

import crypto from 'crypto';
import HyperExpress from '@btc-vision/hyper-express';
import { Config } from './config.js';
import { lookupApiKey, lookupSession } from './db.js';

type Req = HyperExpress.Request;
type Res = HyperExpress.Response;

// ── In-memory rate limit buckets (token bucket per IP/key) ────────────────────
interface Bucket {
    tokens: number;
    lastRefill: number;
}

const buckets = new Map<string, Bucket>();
const BUCKET_INTERVAL_MS = 60_000; // 1 minute refill window

function checkBucket(id: string, rateLimit: number): boolean {
    const now = Date.now();
    let b = buckets.get(id);

    if (!b) {
        b = { tokens: rateLimit, lastRefill: now };
        buckets.set(id, b);
    }

    const elapsed = now - b.lastRefill;
    if (elapsed >= BUCKET_INTERVAL_MS) {
        b.tokens    = rateLimit;
        b.lastRefill = now;
    }

    if (b.tokens <= 0) return false;
    b.tokens--;
    return true;
}

// Clean up stale buckets every 5 minutes
setInterval(() => {
    const cutoff = Date.now() - BUCKET_INTERVAL_MS * 2;
    for (const [id, b] of buckets) {
        if (b.lastRefill < cutoff) buckets.delete(id);
    }
}, 5 * 60_000);

// ── Public helper ─────────────────────────────────────────────────────────────

/**
 * Returns the authenticated key_id (from api_keys) or user_id (from session).
 * Accepts either X-Api-Key or X-Session-Token header.
 */
export async function verifyApiKey(req: Req, res: Res): Promise<string | null> {
    // Try session token first
    const sessionToken = req.headers['x-session-token'] ?? '';
    if (sessionToken) {
        const tokenHash = crypto.createHash('sha256').update(sessionToken).digest('hex');
        const session   = await lookupSession(tokenHash);
        if (session) return session.user_id;
        res.status(401).json({ error: 'Invalid or expired session' });
        return null;
    }

    // Fall back to API key
    const rawKey = req.headers['x-api-key'] ?? '';
    if (!rawKey) {
        res.status(401).json({ error: 'x-api-key or x-session-token required' });
        return null;
    }
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const row     = await lookupApiKey(keyHash);
    if (!row) {
        res.status(401).json({ error: 'Invalid API key' });
        return null;
    }
    return row.id;
}

/** Rate limit gate. Returns true if request should proceed. */
export async function rateLimitCheck(req: Req, res: Res): Promise<boolean> {
    const rawKey = req.headers['x-api-key'] ?? '';
    let rateLimit = 600;
    let bucketId  = `ip:${req.ip}`;

    if (rawKey) {
        const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
        const row     = await lookupApiKey(keyHash).catch(() => null);
        if (row) {
            rateLimit = row.rate_limit ?? 1000;
            bucketId  = `key:${row.id}`;
        }
    }

    if (!checkBucket(bucketId, rateLimit)) {
        res.status(429).json({ error: 'Rate limit exceeded — retry after 60 seconds' });
        return false;
    }

    return true;
}

/** Admin gate — checks X-Admin-Key header against ADMIN_KEY env var. */
export function isAdminRequest(req: Req): boolean {
    const adminKey = req.headers['x-admin-key'] ?? '';
    return adminKey.length > 0 && adminKey === Config.adminKey;
}
