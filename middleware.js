/**
 * BlockFeed middleware — API key authentication + sliding-window rate limiting.
 *
 * Tiers:
 *   public     30 req/min  (IP-keyed, no API key required)
 *   free       60 req/min
 *   pro       600 req/min
 *   enterprise  unlimited
 *
 * Headers set on every response:
 *   X-RateLimit-Limit     requests allowed per minute for this key/IP
 *   X-RateLimit-Remaining remaining requests in current window
 *   X-RateLimit-Reset     Unix timestamp (seconds) when window resets
 */

import { getApiKey } from './db.js';
import { CONFIG } from './config.js';

// ── Rate limit config ─────────────────────────────────────────────────────────
const LIMITS = {
  public:     30,
  free:       60,
  pro:        600,
  enterprise: Infinity,
};

const WINDOW_MS = 60_000; // 1-minute sliding window

// ── In-memory stores ──────────────────────────────────────────────────────────
// key/IP → { count, windowStart }
const rateStore = new Map();

// API key DB cache: rawKey → { tier, name } | null
const keyCache    = new Map();
const keyCacheExp = new Map();
const KEY_CACHE_TTL = 60_000;

// ── Helpers ───────────────────────────────────────────────────────────────────
function slideWindow(id, limit) {
  if (limit === Infinity) {
    return { allowed: true, remaining: Infinity, resetAt: Date.now() + WINDOW_MS };
  }

  const now     = Date.now();
  const stored  = rateStore.get(id);
  const entry   = stored ?? { count: 0, windowStart: now };
  const elapsed = now - entry.windowStart;

  if (elapsed >= WINDOW_MS) {
    rateStore.set(id, { count: 1, windowStart: now });
    return { allowed: true, remaining: limit - 1, resetAt: now + WINDOW_MS };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.windowStart + WINDOW_MS };
  }

  entry.count++;
  rateStore.set(id, entry); // persist the mutation
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.windowStart + WINDOW_MS };
}

async function resolveKey(rawKey) {
  const now = Date.now();
  const exp = keyCacheExp.get(rawKey) ?? 0;

  if (now < exp) return keyCache.get(rawKey);

  const entry = await getApiKey(rawKey).catch(() => null);
  keyCache.set(rawKey, entry);
  keyCacheExp.set(rawKey, now + KEY_CACHE_TTL);
  return entry;
}

function setRateLimitHeaders(res, limit, rl) {
  const limitVal = limit === Infinity ? 'unlimited' : limit;
  const remaining = rl.remaining === Infinity ? 'unlimited' : Math.max(0, rl.remaining);
  res.setHeader('X-RateLimit-Limit',     limitVal);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset',     Math.ceil(rl.resetAt / 1000));
}

function deny(res, status, body) {
  res.writeHead(status, {
    'Content-Type':                'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(body));
}

// ── Main middleware ───────────────────────────────────────────────────────────
/**
 * Returns true if the request may proceed, false if it was rejected.
 * Call before handleRequest(); do NOT call for OPTIONS preflights.
 */
export async function applyMiddleware(req, res) {
  const rawKey = req.headers['x-api-key'];
  let tier  = 'public';
  let rateid = req.socket?.remoteAddress ?? 'anon';

  if (rawKey) {
    // Prevent timing attacks: always hit cache/DB regardless of key length
    if (rawKey.length < 8 || rawKey.length > 128) {
      deny(res, 401, { error: 'Invalid API key' });
      return false;
    }

    const entry = await resolveKey(rawKey);
    if (!entry) {
      deny(res, 401, { error: 'Invalid API key' });
      return false;
    }

    tier   = entry.tier;
    rateid = rawKey; // rate-limit per key, not per IP
  }

  const limit = LIMITS[tier] ?? LIMITS.public;
  const rl    = slideWindow(rateid, limit);

  setRateLimitHeaders(res, limit, rl);

  if (!rl.allowed) {
    const retryAfter = Math.ceil((rl.resetAt - Date.now()) / 1000);
    res.setHeader('Retry-After', retryAfter);
    deny(res, 429, { error: 'Rate limit exceeded', retry_after: retryAfter });
    return false;
  }

  return true;
}

// ── Admin key guard ───────────────────────────────────────────────────────────
/**
 * Returns true if the request carries a valid admin key.
 * Used to protect POST /v1/admin/keys.
 */
export function isAdminRequest(req) {
  const key = req.headers['x-admin-key'];
  return key && key === CONFIG.adminKey;
}
