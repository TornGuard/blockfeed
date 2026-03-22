/**
 * BlockFeed webhook delivery engine.
 *
 * Flow:
 *   indexer calls deliverEvents(events[]) after each block insert.
 *   For each event, matching active webhooks are fetched and fired in parallel.
 *   Failed deliveries are retried up to 3 times with exponential backoff.
 *   After 10 consecutive failures a webhook is auto-disabled (via DB).
 *
 * Security:
 *   Every POST carries  X-BlockFeed-Signature: sha256=<hmac-hex>
 *   signed with the per-webhook secret so recipients can verify authenticity.
 */

import crypto from 'crypto';
import { getMatchingWebhooks, recordWebhookDelivery } from './db.js';

const MAX_ATTEMPTS = 3;
const TIMEOUT_MS   = 10_000;
const BACKOFF_MS   = [0, 2_000, 4_000]; // per attempt index

// ── Public entry point ────────────────────────────────────────────────────────
/**
 * Fire-and-forget: deliver all events to matching webhooks.
 * Never throws — errors are handled internally.
 */
export function deliverEvents(events) {
  for (const event of events) {
    _dispatchEvent(event).catch(() => {});
  }
}

// ── Internal ──────────────────────────────────────────────────────────────────
async function _dispatchEvent(event) {
  let hooks;
  try {
    hooks = await getMatchingWebhooks(event.event_type, event.contract_address);
  } catch {
    return; // DB error — skip silently
  }

  for (const hook of hooks) {
    _deliver(hook, event, 0);
  }
}

function _deliver(hook, event, attempt) {
  const delay = BACKOFF_MS[attempt] ?? BACKOFF_MS[BACKOFF_MS.length - 1];
  setTimeout(() => _send(hook, event, attempt), delay);
}

async function _send(hook, event, attempt) {
  const payload = JSON.stringify({
    id:       `bf_${event.id}`,
    event:    event.event_type,
    contract: event.contract_address,
    block:    event.block_height,
    tx_hash:  event.tx_hash  ?? null,
    from:     event.from_address ?? null,
    decoded:  event.decoded  ?? null,
    ts:       event.ts,
  });

  const signature = crypto
    .createHmac('sha256', hook.secret)
    .update(payload)
    .digest('hex');

  let success = false;
  try {
    const res = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type':           'application/json',
        'X-BlockFeed-Signature':  `sha256=${signature}`,
        'X-BlockFeed-Event':      event.event_type,
        'User-Agent':             'BlockFeed-Webhook/1.0',
      },
      body:   payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    success = res.status >= 200 && res.status < 300;
  } catch {
    success = false;
  }

  await recordWebhookDelivery(hook.id, success).catch(() => {});

  if (!success && attempt + 1 < MAX_ATTEMPTS) {
    _deliver(hook, event, attempt + 1);
  }
}
