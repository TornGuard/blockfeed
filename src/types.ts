/**
 * Shared type definitions for BlockFeed.
 */

// ── Database rows ─────────────────────────────────────────────────────────────

export interface DbBlockActivity {
    id: number;
    block_height: number;
    tx_count: number;
    contract_calls: number;
    events_count: number;
    indexed_at: Date;
}

export interface DbOracleFeed {
    id: number;
    block_height: number;
    median_fee_scaled: number;
    mempool_count: number;
    tx_id: string | null;
    submitted_at: Date;
}

export interface DbContractEvent {
    id: number;
    block_height: number;
    tx_hash: string;
    contract_address: string;
    event_type: string;
    from_address: string | null;
    decoded: Record<string, unknown> | null;
    ts: Date;
}

export interface DbToken {
    contract_address: string;
    name: string | null;
    symbol: string | null;
    decimals: number | null;
    total_supply: string | null;
    fetch_status: string | null;
    fetched_at: Date | null;
}

export interface DbOraclePrice {
    id: number;
    symbol: string;
    price: number;
    sources: Record<string, number>;
    confidence: number;
    signature: string | null;
    captured_at: Date;
}

export interface DbWebhook {
    id: string;
    url: string;
    events: string[];
    contract_filter: string | null;
    active: boolean;
    created_at: Date;
    delivery_count: number;
    last_delivery_at: Date | null;
    last_status_code: number | null;
}

export interface DbApiKey {
    id: string;
    key_hash: string;
    label: string;
    rate_limit: number;
    created_at: Date;
}

export interface DbBet {
    bet_id: number;
    bet_type: number;
    param1: string | null;
    param2: string | null;
    amount: string;
    end_block: number;
    status: number;
    won: boolean | null;
    payout: string | null;
    wallet: string | null;
    token_symbol: string | null;
    placed_at: Date;
    resolved_at: Date | null;
    resolve_tx: string | null;
}

// ── API response shapes ───────────────────────────────────────────────────────

export interface ApiOk<T> {
    ok: true;
    data: T;
}

export interface ApiError {
    error: string;
}

export type ApiResponse<T> = ApiOk<T> | ApiError;

// ── Oracle ────────────────────────────────────────────────────────────────────

export interface OracleTick {
    id: number;
    symbol: string;
    price: number;
    price_scaled: number;
    confidence: number;
    sources: Record<string, number>;
    signature: string | null;
    pubkey: string;
    captured_at: Date;
}

export type OracleInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export interface OhlcvCandle {
    ts: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    ticks: number;
}

// ── WebSocket protocol ────────────────────────────────────────────────────────

export type WsChannel = 'blocks' | 'oracle' | 'events' | 'address' | 'contract' | 'event_type';

export interface WsSubscribeMsg {
    action: 'subscribe' | 'unsubscribe';
    channel: WsChannel;
    filter?: string;
}

export interface WsPingMsg {
    action: 'ping';
}

export type WsClientMsg = WsSubscribeMsg | WsPingMsg;

export interface WsClientSubs {
    blocks: boolean;
    oracle: boolean;
    events: boolean;
    address: Set<string> | null;
    contract: Set<string> | null;
    event_type: Set<string> | null;
}

// ── Worker messages ───────────────────────────────────────────────────────────

export interface WorkerBroadcastMsg {
    type: 'broadcast';
    event: string;
    data: unknown;
}

export interface WorkerLogMsg {
    type: 'log';
    level: 'info' | 'warn' | 'error';
    message: string;
}

export type WorkerMsg = WorkerBroadcastMsg | WorkerLogMsg;

// ── RPC proxy ─────────────────────────────────────────────────────────────────

export interface JsonRpcRequest {
    jsonrpc: '2.0';
    method: string;
    params?: unknown[];
    id?: number | string | null;
}

export interface JsonRpcResponse {
    jsonrpc: '2.0';
    id: number | string | null;
    result?: unknown;
    error?: { code: number; message: string };
}

// ── Address endpoints ─────────────────────────────────────────────────────────

export interface AddressOverview {
    address: string;
    tx_count: number;
    contracts_touched: number;
    first_seen_block: string;
    last_seen_block: string;
    total_events: number;
    top_tokens: TokenActivity[];
}

export interface TokenActivity {
    contract_address: string;
    symbol: string | null;
    name: string | null;
    decimals: number | null;
    interaction_count: number;
    last_seen_block: string;
}

// ── Analytics ─────────────────────────────────────────────────────────────────

export interface VolumeStats {
    transfers_24h: number;
    transfers_7d: number;
    volume_24h: string;
    volume_7d: string;
    active_tokens_24h: number;
}

export interface TrendingToken {
    contract_address: string;
    symbol: string | null;
    name: string | null;
    transfers_24h: number;
    unique_senders: number;
}

// ── Search ────────────────────────────────────────────────────────────────────

export interface SearchResults {
    blocks: DbBlockActivity[];
    txs: { tx_hash: string; block_height: number; ts: Date }[];
    contracts: DbToken[];
    tokens: DbToken[];
}
