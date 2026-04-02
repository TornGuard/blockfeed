/**
 * BlockFeed GraphQL API
 *
 * Single endpoint: POST /graphql  — execute queries
 *                  GET  /graphql  — GraphiQL interactive playground
 *
 * Uses the `graphql` package execute() directly (no Node.js http adapter needed),
 * so it is fully compatible with HyperExpress / uWebSockets.js.
 */

import { graphql, buildSchema } from 'graphql';
import HyperExpress from '@btc-vision/hyper-express';
import {
    getLatestFee, getFeeHistory, getFeeStats,
    getBlockActivity, getLatestBlockActivity, getActivityStats,
    getRecentEvents, getTopContracts, getEventTypeSummary, getContractEvents, getContractStats,
    getToken, getTokens, getTokenHolders,
    getLatestOraclePrice, getAllLatestOraclePrices, getOraclePriceHistory, getOhlcv,
    getAddressOverview, getAddressTxs, getAddressTokenActivity,
    getTxByHash,
    getVolumeAnalytics, getTrendingTokens,
    globalSearch,
    getBetStats,
} from './db.js';

// ── Schema ────────────────────────────────────────────────────────────────────

const schema = buildSchema(`
  type Query {
    # ── Fees & Mempool ───────────────────────────────────────────────────────
    """Latest Bitcoin fee rate and mempool snapshot."""
    latestFee: Fee

    """Fee rate history. Returns up to \`blocks\` most recent entries."""
    feeHistory(blocks: Int): [Fee!]!

    """Aggregate fee statistics over the last 7 days."""
    feeStats: FeeStats

    # ── Block Activity ───────────────────────────────────────────────────────
    """OPNet block activity — tx counts, event counts, contract calls."""
    blocks(limit: Int): [Block!]!

    """Single most recent OPNet block."""
    latestBlock: Block

    """Aggregate OPNet chain statistics."""
    chainStats: ChainStats

    # ── Events ───────────────────────────────────────────────────────────────
    """Most recent contract events across all contracts."""
    recentEvents(limit: Int, type: String, cursor: Int): [Event!]!

    """Count of each event type across all indexed history."""
    eventTypes: [EventTypeSummary!]!

    # ── Contracts ────────────────────────────────────────────────────────────
    """Top contracts ranked by total event count."""
    topContracts(limit: Int): [ContractSummary!]!

    """All events emitted by a specific contract."""
    contractEvents(address: String!, limit: Int, type: String, cursor: Int): [Event!]!

    """Aggregate stats for a specific contract."""
    contractStats(address: String!): ContractStats

    # ── Tokens ───────────────────────────────────────────────────────────────
    """Single OP-20 token by contract address."""
    token(address: String!): Token

    """All indexed OP-20 tokens with known metadata."""
    tokens(limit: Int): [Token!]!

    """Estimated token holders derived from Transfer events."""
    tokenHolders(address: String!, limit: Int): [TokenHolder!]!

    # ── Address ──────────────────────────────────────────────────────────────
    """Overview stats for any address (wallet or contract)."""
    address(address: String!): AddressOverview

    """Paginated transaction history for an address."""
    addressTxs(address: String!, limit: Int, cursor: Int): [Event!]!

    """Token interactions for an address."""
    addressTokens(address: String!, limit: Int): [TokenActivity!]!

    # ── Transactions ─────────────────────────────────────────────────────────
    """All events in a transaction by hash."""
    tx(hash: String!): [Event!]!

    # ── Oracle ───────────────────────────────────────────────────────────────
    """Latest price for a symbol (default: BTC/USD)."""
    oraclePrice(symbol: String): OraclePrice

    """Latest price for all tracked symbols."""
    oraclePrices: [OraclePrice!]!

    """Price history for a symbol."""
    oraclePriceHistory(symbol: String!, limit: Int): [OraclePrice!]!

    """OHLCV candle data. interval: 1m 5m 15m 1h 4h 1d"""
    ohlcv(symbol: String!, interval: String, limit: Int): [Candle!]!

    # ── Analytics ────────────────────────────────────────────────────────────
    """Volume analytics. Optionally scoped to a contract address."""
    volumeAnalytics(contract: String): VolumeAnalytics

    """Trending OP-20 tokens by 24h transfer count."""
    trendingTokens(limit: Int): [TrendingToken!]!

    # ── Search ───────────────────────────────────────────────────────────────
    """Global search — accepts block number, tx hash, address, or token symbol."""
    search(q: String!): [SearchResult!]!

    # ── Bets ─────────────────────────────────────────────────────────────────
    """OPBET prediction market aggregate stats."""
    betStats: BetStats
  }

  # ── Types ─────────────────────────────────────────────────────────────────

  type Fee {
    block_height: Int
    """Fee rate in sat/vB (not scaled)."""
    fee_rate: Float
    mempool_count: Int
    submitted_at: String
  }

  type FeeStats {
    min_fee: Float
    max_fee: Float
    avg_fee: Float
    min_mempool: Int
    max_mempool: Int
    avg_mempool: Float
    total_feeds: Int
  }

  type Block {
    block_height: Int
    tx_count: Int
    contract_calls: Int
    events_count: Int
    indexed_at: String
  }

  type ChainStats {
    total_blocks: Int
    total_txs: Int
    total_events: Int
    avg_tx_per_block: Float
    latest_block: Int
    total_contracts: Int
  }

  type Event {
    id: Int
    block_height: Int
    tx_hash: String
    contract_address: String
    event_type: String
    from_address: String
    ts: String
  }

  type EventTypeSummary {
    event_type: String
    count: Int
  }

  type ContractSummary {
    contract_address: String
    event_count: Int
    tx_count: Int
    last_active_block: Int
  }

  type ContractStats {
    total_events: Int
    total_txs: Int
    event_types: Int
    first_seen: Int
    last_seen: Int
  }

  type Token {
    contract_address: String
    name: String
    symbol: String
    decimals: Int
    total_supply: String
  }

  type TokenHolder {
    address: String
    net_balance: String
    receives: Int
    sends: Int
  }

  type AddressOverview {
    tx_count: Int
    contracts_touched: Int
    first_seen_block: String
    last_seen_block: String
    total_events: Int
    address_type: String
  }

  type TokenActivity {
    contract_address: String
    symbol: String
    name: String
    decimals: Int
    interaction_count: Int
    last_seen_block: String
  }

  type OraclePrice {
    id: Int
    symbol: String
    price: Float
    confidence: Float
    signature: String
    captured_at: String
  }

  type Candle {
    ts: String
    open: Float
    high: Float
    low: Float
    close: Float
    ticks: Int
  }

  type VolumeAnalytics {
    transfers_24h: Int
    transfers_7d: Int
    volume_24h: String
    volume_7d: String
    active_tokens_24h: Int
  }

  type TrendingToken {
    contract_address: String
    symbol: String
    name: String
    transfers_24h: Int
    unique_senders: Int
  }

  type SearchResult {
    type: String
    id: String
    description: String
  }

  type BetStats {
    total_bets: Int
    open_bets: Int
    resolved_bets: Int
    total_volume: String
  }
`);

// ── Resolvers ─────────────────────────────────────────────────────────────────

/** Convert any Date/timestamp value to ISO 8601 string */
function toISO(val: unknown): string | null {
    if (val == null) return null;
    if (val instanceof Date) return val.toISOString();
    if (typeof val === 'string' && val.includes('T')) return val;
    if (typeof val === 'number' || (typeof val === 'string' && /^\d+$/.test(val))) {
        return new Date(Number(val)).toISOString();
    }
    return String(val);
}

/** Map raw DB fee row → GraphQL Fee (divide scaled value by 100, normalize timestamps) */
function mapFee(row: Record<string, unknown> | null) {
    if (!row) return null;
    return {
        ...row,
        fee_rate:     row.median_fee_scaled != null ? (row.median_fee_scaled as number) / 100 : null,
        submitted_at: toISO(row.submitted_at),
    };
}

const rootValue = {
    // ── Fees ──────────────────────────────────────────────────────────────────
    latestFee: async () => mapFee(await getLatestFee() as unknown as Record<string, unknown>),
    feeHistory: async ({ blocks }: { blocks?: number }) => {
        const rows = await getFeeHistory(blocks ?? 50);
        return rows.map(r => mapFee(r as unknown as Record<string, unknown>));
    },
    feeStats: () => getFeeStats(),

    // ── Blocks ────────────────────────────────────────────────────────────────
    blocks: ({ limit }: { limit?: number }) => getBlockActivity(limit ?? 20),
    latestBlock: () => getLatestBlockActivity(),
    chainStats: () => getActivityStats(),

    // ── Events ───────────────────────────────────────────────────────────────
    recentEvents: async ({ limit, type, cursor }: { limit?: number; type?: string; cursor?: number }) => {
        const rows = await getRecentEvents(limit ?? 20, type ?? null, cursor ?? null);
        return rows.map(r => ({ ...r, ts: toISO(r.ts) }));
    },
    eventTypes: () => getEventTypeSummary(),

    // ── Contracts ─────────────────────────────────────────────────────────────
    topContracts: ({ limit }: { limit?: number }) => getTopContracts(limit ?? 10),
    contractEvents: async ({ address, limit, type, cursor }: { address: string; limit?: number; type?: string; cursor?: number }) => {
        const rows = await getContractEvents(address, limit ?? 25, type ?? null, cursor ?? null);
        return rows.map(r => ({ ...r, ts: toISO(r.ts) }));
    },
    contractStats: ({ address }: { address: string }) => getContractStats(address),

    // ── Tokens ───────────────────────────────────────────────────────────────
    token: ({ address }: { address: string }) => getToken(address),
    tokens: ({ limit }: { limit?: number }) => getTokens(limit ?? 20),
    tokenHolders: ({ address, limit }: { address: string; limit?: number }) =>
        getTokenHolders(address, limit ?? 50),

    // ── Address ───────────────────────────────────────────────────────────────
    address: ({ address }: { address: string }) => getAddressOverview(address),
    addressTxs: async ({ address, limit, cursor }: { address: string; limit?: number; cursor?: number }) => {
        const rows = await getAddressTxs(address, limit ?? 25, cursor ?? null);
        return rows.map(r => ({ ...r, ts: toISO(r.ts) }));
    },
    addressTokens: ({ address, limit }: { address: string; limit?: number }) =>
        getAddressTokenActivity(address, limit ?? 20),

    // ── Transactions ──────────────────────────────────────────────────────────
    tx: async ({ hash }: { hash: string }) => {
        const rows = await getTxByHash(hash);
        return rows.map(r => ({ ...r, ts: toISO(r.ts) }));
    },

    // ── Oracle ────────────────────────────────────────────────────────────────
    oraclePrice: async ({ symbol }: { symbol?: string }) => {
        const r = await getLatestOraclePrice(symbol ?? 'BTC/USD');
        return r ? { ...r, captured_at: toISO(r.captured_at) } : null;
    },
    oraclePrices: async () => {
        const rows = await getAllLatestOraclePrices();
        return rows.map(r => ({ ...r, captured_at: toISO(r.captured_at) }));
    },
    oraclePriceHistory: async ({ symbol, limit }: { symbol: string; limit?: number }) => {
        const rows = await getOraclePriceHistory(symbol, limit ?? 100);
        return rows.map(r => ({ ...r, captured_at: toISO(r.captured_at) }));
    },
    ohlcv: async ({ symbol, interval, limit }: { symbol: string; interval?: string; limit?: number }) => {
        const rows = await getOhlcv(symbol, interval ?? '1h', limit ?? 100);
        return (rows as Record<string, unknown>[]).map(r => ({ ...r, ts: toISO(r.ts) }));
    },

    // ── Analytics ─────────────────────────────────────────────────────────────
    volumeAnalytics: ({ contract }: { contract?: string }) => getVolumeAnalytics(contract ?? null),
    trendingTokens: ({ limit }: { limit?: number }) => getTrendingTokens(limit ?? 10),

    // ── Search ────────────────────────────────────────────────────────────────
    search: ({ q }: { q: string }) => globalSearch(q),

    // ── Bets ──────────────────────────────────────────────────────────────────
    betStats: () => getBetStats(),
};

// ── GraphiQL HTML ─────────────────────────────────────────────────────────────

const GRAPHIQL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>BlockFeed GraphQL Playground</title>
  <link rel="stylesheet" href="https://unpkg.com/graphiql@3/graphiql.min.css" />
  <style>body { margin: 0; height: 100vh; }</style>
</head>
<body>
  <div id="app" style="height:100vh;"></div>
  <script crossorigin src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
  <script crossorigin src="https://unpkg.com/graphiql@3/graphiql.min.js"></script>
  <script>
    const fetcher = GraphiQL.createFetcher({ url: '/graphql' });
    const defaultQuery = \`# BlockFeed GraphQL Playground
# Try a query:
{
  latestFee { fee_rate mempool_count submitted_at }
  oraclePrices { symbol price confidence captured_at }
  trendingTokens(limit: 5) { symbol transfers_24h unique_senders }
}
\`;
    ReactDOM.createRoot(document.getElementById('app')).render(
      React.createElement(GraphiQL, { fetcher, defaultQuery })
    );
  </script>
</body>
</html>`;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function handleGraphQL(
    req: HyperExpress.Request,
    res: HyperExpress.Response,
): Promise<void> {
    // Serve GraphiQL playground on GET
    if (req.method === 'GET') {
        res.header('Content-Type', 'text/html; charset=utf-8');
        res.send(GRAPHIQL_HTML);
        return;
    }

    // Parse GraphQL request body
    let query: string;
    let variables: Record<string, unknown> | undefined;
    let operationName: string | undefined;

    try {
        const body = await req.json() as {
            query?: string;
            variables?: Record<string, unknown>;
            operationName?: string;
        };
        if (!body.query) {
            res.status(400).json({ errors: [{ message: 'Missing "query" field in request body' }] });
            return;
        }
        query = body.query;
        variables = body.variables;
        operationName = body.operationName;
    } catch {
        res.status(400).json({ errors: [{ message: 'Invalid JSON body' }] });
        return;
    }

    // Execute
    const result = await graphql({
        schema,
        source: query,
        rootValue,
        variableValues: variables,
        operationName,
    });

    res.header('Content-Type', 'application/json');
    res.json(result);
}
