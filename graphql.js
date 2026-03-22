/**
 * BlockFeed GraphQL API
 *
 * Endpoint: POST /graphql  (also accepts GET with ?query=)
 * Playground: GET /graphql  (returns GraphiQL HTML in browser)
 *
 * All REST data is exposed here. Admin mutations require x-admin-key header.
 */

import { buildSchema, graphql } from 'graphql';
import { getOraclePubKey } from './oracle.js';
import {
  getLatestFee, getFeeHistory, getFeeStats,
  getBlockActivity, getLatestBlockActivity, getActivityStats,
  getRecentEvents, getTopContracts, getEventTypeSummary,
  getLatestHistogram,
  getToken, getTokens,
  getContractEvents, getContractStats,
  getBetStats,
  createApiKey, listApiKeys,
  createWebhook, listWebhooks, deleteWebhook, toggleWebhook, countWebhooks,
  getLatestOraclePrice, getOraclePriceHistory, getOracleSymbols,
} from './db.js';
import { getConnectedClients } from './feed.js';
import { isAdminRequest } from './middleware.js';
import crypto from 'crypto';

// ── Schema ────────────────────────────────────────────────────────────────────
const schema = buildSchema(`
  type Status {
    ok:           Boolean!
    service:      String!
    version:      String!
    network:      String!
    latest_block: Int
    ws_clients:   Int!
    uptime:       Int!
  }

  type Fee {
    block:   Int!
    fee:     Float!
    mempool: Int!
    ts:      String!
  }

  type FeeStats {
    min_fee:      Float
    max_fee:      Float
    avg_fee:      Float
    min_mempool:  Int
    max_mempool:  Int
    avg_mempool:  Int
    total_blocks: Int
  }

  type MempoolDepth {
    block:   Int!
    mempool: Int!
    fee:     Float!
    ts:      String!
  }

  type Histogram {
    block_height: Int
    histogram:    String
    captured_at:  String
  }

  type BlockSummary {
    block: Int!
    ts:    String!
  }

  type BlockActivity {
    block_height:   Int!
    tx_count:       Int
    contract_calls: Int
    unique_senders: Int
    gas_used:       String
    events_count:   Int
    indexed_at:     String
  }

  type ActivityStats {
    total_blocks_indexed: Int
    total_txs:            String
    total_contract_calls: String
    total_events:         String
    avg_txs_per_block:    Float
    avg_calls_per_block:  Float
    peak_gas:             String
  }

  type Event {
    id:               Int!
    block_height:     Int!
    tx_hash:          String
    contract_address: String!
    event_type:       String!
    from_address:     String
    decoded:          String
    ts:               String
  }

  type EventPage {
    count:       Int!
    next_cursor: Int
    data:        [Event!]!
  }

  type EventType {
    event_type: String!
    count:      Int!
  }

  type Contract {
    contract_address:    String!
    interaction_count:   Int!
    unique_event_types:  Int!
    last_active_block:   Int
  }

  type ContractStats {
    total_events:       Int
    unique_event_types: Int
    active_blocks:      Int
    first_block:        Int
    last_block:         Int
    event_types:        [String]
  }

  type Token {
    contract_address: String!
    name:             String
    symbol:           String
    decimals:         Int
    total_supply:     String
    icon:             String
    fetch_status:     String!
    first_seen_block: Int
    last_seen_block:  Int
    updated_at:       String
    total_events:     Int
    last_event_block: Int
  }

  type TokenPage {
    count: Int!
    data:  [Token!]!
  }

  type BetStats {
    total_bets:    Int
    active_bets:   Int
    total_wins:    Int
    total_losses:  Int
    total_paid_out: String
  }

  type ApiKey {
    name:          String!
    tier:          String!
    request_count: String!
    last_used_at:  String
    created_at:    String!
  }

  type NewApiKey {
    key:  String!
    name: String!
    tier: String!
  }

  type OraclePrice {
    id:          Int!
    symbol:      String!
    price:       Float!
    sources:     String
    confidence:  Float!
    signature:   String!
    captured_at: String!
  }

  type OracleSummary {
    symbol:      String!
    price:       Float!
    confidence:  Float!
    captured_at: String!
  }

  type OraclePubKey {
    pubkey:    String!
    algorithm: String!
  }

  type Webhook {
    id:               Int!
    url:              String!
    event_type:       String
    contract_address: String
    active:           Boolean!
    failure_count:    Int!
    last_fired_at:    String
    created_at:       String!
  }

  type NewWebhook {
    id:               Int!
    url:              String!
    event_type:       String
    contract_address: String
    secret:           String!
    created_at:       String!
    notice:           String!
  }

  type Query {
    status:              Status!
    latestFee:           Fee
    feeHistory(limit: Int): [Fee!]!
    feeStats:            FeeStats!
    mempoolDepth:        MempoolDepth
    mempoolHistogram:    Histogram
    latestBlock:         BlockSummary
    blockActivity(limit: Int): [BlockActivity!]!
    latestBlockActivity: BlockActivity
    activityStats:       ActivityStats!
    recentEvents(limit: Int, type: String, cursor: Int): EventPage!
    eventTypes:          [EventType!]!
    topContracts(limit: Int): [Contract!]!
    contractEvents(address: String!, limit: Int, cursor: Int, type: String): EventPage!
    contractStats(address: String!): ContractStats
    tokens(limit: Int, cursor: String): TokenPage!
    token(address: String!): Token
    tokenTransfers(address: String!, limit: Int, cursor: Int): EventPage!
    betStats:            BetStats!
    oraclePubKey:        OraclePubKey!
    oraclePrices:        [OracleSummary!]!
    oraclePrice(symbol: String): OraclePrice
    oracleHistory(symbol: String, limit: Int): [OracleSummary!]!
    adminKeys:           [ApiKey!]!
    myWebhooks:          [Webhook!]!
  }

  type Mutation {
    createApiKey(name: String!, tier: String): NewApiKey!
    registerWebhook(url: String!, event_type: String, contract_address: String): NewWebhook!
    deleteWebhook(id: Int!): Boolean!
    toggleWebhook(id: Int!, active: Boolean!): Boolean!
  }
`);

// ── Helpers ───────────────────────────────────────────────────────────────────
function formatFee(row) {
  return {
    block:   row.block_height,
    fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
    mempool: row.mempool_count,
    ts:      row.submitted_at,
  };
}

function clamp(val, def, max) {
  const n = parseInt(val ?? def, 10);
  return Math.min(Number.isFinite(n) && n > 0 ? n : def, max);
}

function toStr(val) {
  return val == null ? null : String(val);
}

function eventPage(rows) {
  return {
    count:       rows.length,
    next_cursor: rows.length > 0 ? rows[rows.length - 1].id : null,
    data:        rows.map(r => ({ ...r, decoded: r.decoded ? JSON.stringify(r.decoded) : null })),
  };
}

// ── Root resolvers ────────────────────────────────────────────────────────────
const rootValue = {
  // Status
  status: async () => {
    const latest = await getLatestFee();
    return {
      ok:           true,
      service:      'BlockFeed',
      version:      '0.2.0',
      network:      'op_testnet',
      latest_block: latest?.block_height ?? null,
      ws_clients:   getConnectedClients(),
      uptime:       Math.floor(process.uptime()),
    };
  },

  // Fees
  latestFee: async () => {
    const row = await getLatestFee();
    return row ? formatFee(row) : null;
  },
  feeHistory: async ({ limit }) => {
    const rows = await getFeeHistory(clamp(limit, 50, 500));
    return rows.map(formatFee);
  },
  feeStats: async () => getFeeStats(),

  // Mempool
  mempoolDepth: async () => {
    const row = await getLatestFee();
    if (!row) return null;
    return {
      block:   row.block_height,
      mempool: row.mempool_count,
      fee:     parseFloat((row.median_fee_scaled / 100).toFixed(2)),
      ts:      row.submitted_at,
    };
  },
  mempoolHistogram: async () => {
    const snap = await getLatestHistogram();
    if (!snap) return null;
    return { ...snap, histogram: JSON.stringify(snap.histogram) };
  },

  // Blocks
  latestBlock: async () => {
    const row = await getLatestFee();
    return row ? { block: row.block_height, ts: row.submitted_at } : null;
  },
  blockActivity: async ({ limit }) => {
    const rows = await getBlockActivity(clamp(limit, 20, 200));
    return rows.map(r => ({ ...r, gas_used: toStr(r.gas_used) }));
  },
  latestBlockActivity: async () => {
    const row = await getLatestBlockActivity();
    return row ? { ...row, gas_used: toStr(row.gas_used) } : null;
  },
  activityStats: async () => {
    const s = await getActivityStats();
    return {
      ...s,
      total_txs:            toStr(s.total_txs),
      total_contract_calls: toStr(s.total_contract_calls),
      total_events:         toStr(s.total_events),
      peak_gas:             toStr(s.peak_gas),
    };
  },

  // Events
  recentEvents: async ({ limit, type, cursor }) => {
    const rows = await getRecentEvents(clamp(limit, 50, 200), type ?? null, cursor ?? null);
    return eventPage(rows);
  },
  eventTypes: async () => getEventTypeSummary(),

  // Contracts
  topContracts: async ({ limit }) => getTopContracts(clamp(limit, 10, 50)),
  contractEvents: async ({ address, limit, cursor, type }) => {
    const rows = await getContractEvents({
      address,
      limit:  clamp(limit, 50, 200),
      cursor: cursor ?? null,
      type:   type ?? null,
    });
    return eventPage(rows);
  },
  contractStats: async ({ address }) => {
    const stats = await getContractStats(address);
    if (!stats || stats.total_events === 0) return null;
    return stats;
  },

  // Tokens
  tokens: async ({ limit, cursor }) => {
    const rows = await getTokens({ limit: clamp(limit, 20, 100), cursor: cursor ?? null });
    return { count: rows.length, data: rows.map(r => ({ ...r, total_supply: toStr(r.total_supply) })) };
  },
  token: async ({ address }) => {
    const t = await getToken(address);
    return t ? { ...t, total_supply: toStr(t.total_supply) } : null;
  },
  tokenTransfers: async ({ address, limit, cursor }) => {
    const rows = await getContractEvents({
      address,
      limit:  clamp(limit, 50, 200),
      cursor: cursor ?? null,
      type:   'Transferred',
    });
    return eventPage(rows);
  },

  // Bets
  betStats: async () => getBetStats(),

  // Oracle
  oraclePubKey: () => ({ pubkey: getOraclePubKey(), algorithm: 'ed25519' }),
  oraclePrices: async () => getOracleSymbols(),
  oraclePrice: async ({ symbol }) => {
    const row = await getLatestOraclePrice(symbol || 'BTC/USD');
    if (!row) return null;
    return { ...row, sources: JSON.stringify(row.sources) };
  },
  oracleHistory: async ({ symbol, limit }) => {
    return getOraclePriceHistory(symbol || 'BTC/USD', clamp(limit, 50, 500));
  },

  // Admin (read)
  adminKeys: async (_, ctx) => {
    if (!ctx?.isAdmin) throw new Error('Forbidden');
    const keys = await listApiKeys();
    return keys.map(k => ({ ...k, request_count: toStr(k.request_count) }));
  },

  // Webhooks (read — own key only)
  myWebhooks: async (_, ctx) => {
    if (!ctx?.apiKey) throw new Error('API key required');
    return listWebhooks(ctx.apiKey);
  },

  // Admin mutation
  createApiKey: async ({ name, tier }, ctx) => {
    if (!ctx?.isAdmin) throw new Error('Forbidden');
    const safeName = String(name || '').trim().slice(0, 100);
    if (!safeName) throw new Error('name is required');
    const safeTier = ['free', 'pro', 'enterprise'].includes(tier) ? tier : 'free';
    const key = crypto.randomBytes(32).toString('hex');
    await createApiKey(key, safeName, safeTier);
    return { key, name: safeName, tier: safeTier };
  },

  // Webhook mutations
  registerWebhook: async ({ url, event_type, contract_address }, ctx) => {
    if (!ctx?.apiKey) throw new Error('API key required');
    const LIMITS = { free: 5, pro: 25, enterprise: Infinity };
    const cap = LIMITS[ctx.apiKeyTier] ?? LIMITS.free;
    const current = await countWebhooks(ctx.apiKey);
    if (current >= cap) throw new Error(`Webhook limit reached (${cap} for ${ctx.apiKeyTier} tier)`);
    const cleanUrl = String(url || '').trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      throw new Error('url must be a valid http/https URL');
    }
    if (contract_address && !/^0x[0-9a-f]+$/i.test(contract_address)) {
      throw new Error('invalid contract_address');
    }
    const secret = crypto.randomBytes(24).toString('hex');
    const row = await createWebhook(ctx.apiKey, cleanUrl, secret, event_type ?? null, contract_address ?? null);
    return {
      id: row.id, url: cleanUrl,
      event_type: event_type ?? null,
      contract_address: contract_address ?? null,
      secret,
      created_at: row.created_at,
      notice: 'Save the secret — it will not be shown again.',
    };
  },
  deleteWebhook: async ({ id }, ctx) => {
    if (!ctx?.apiKey) throw new Error('API key required');
    return deleteWebhook(id, ctx.apiKey);
  },
  toggleWebhook: async ({ id, active }, ctx) => {
    if (!ctx?.apiKey) throw new Error('API key required');
    return toggleWebhook(id, ctx.apiKey, active);
  },
};

// ── GraphiQL HTML ─────────────────────────────────────────────────────────────
const GRAPHIQL_HTML = `<!DOCTYPE html>
<html>
<head>
  <title>BlockFeed GraphQL</title>
  <style>body { margin: 0; } #graphiql { height: 100vh; }</style>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
</head>
<body>
  <div id="graphiql"></div>
  <script src="https://unpkg.com/graphiql/graphiql.min.js"></script>
  <script>
    const root = ReactDOM.createRoot(document.getElementById('graphiql'));
    root.render(React.createElement(GraphiQL, {
      fetcher: GraphiQL.createFetcher({ url: '/graphql' }),
      defaultEditorToolsVisibility: true,
    }));
  </script>
</body>
</html>`;

// ── Handler ───────────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key, X-Admin-Key',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 65536) req.destroy(); });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * Handle a /graphql request.
 * Returns true if handled (so index.js knows not to pass to REST router).
 */
export async function handleGraphQL(req, res) {
  // Serve GraphiQL for browser GET requests
  if (req.method === 'GET') {
    const accept = req.headers['accept'] || '';
    if (accept.includes('text/html')) {
      res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html' });
      res.end(GRAPHIQL_HTML);
      return true;
    }
  }

  // Parse query from GET params or POST body
  let queryDoc, variables, operationName;
  if (req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    queryDoc      = url.searchParams.get('query');
    operationName = url.searchParams.get('operationName');
    try { variables = JSON.parse(url.searchParams.get('variables') || 'null'); } catch { variables = null; }
  } else if (req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch {
      res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON body' }] }));
      return true;
    }
    queryDoc      = body.query;
    variables     = body.variables;
    operationName = body.operationName;
  } else {
    res.writeHead(405, CORS_HEADERS);
    res.end();
    return true;
  }

  if (!queryDoc) {
    res.writeHead(400, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ message: 'No query provided' }] }));
    return true;
  }

  // Build context (admin flag + API key identity)
  const ctx = {
    isAdmin:    isAdminRequest(req),
    apiKey:     req.apiKeyEntry?.key  ?? null,
    apiKeyTier: req.apiKeyEntry?.tier ?? 'public',
  };

  // Wrap rootValue to inject context for admin resolvers
  const root = Object.fromEntries(
    Object.entries(rootValue).map(([k, fn]) => [
      k,
      (args) => fn(args, ctx),
    ])
  );

  const result = await graphql({
    schema,
    source:        queryDoc,
    rootValue:     root,
    variableValues: variables,
    operationName,
    contextValue:  ctx,
  });

  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'application/json' });
  res.end(JSON.stringify(result));
  return true;
}
