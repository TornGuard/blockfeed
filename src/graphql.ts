/**
 * GraphQL API for BlockFeed.
 * Provides a typed query layer over the REST API data.
 */

import { createHandler } from 'graphql-http/lib/use/node';
import { buildSchema } from 'graphql';
import HyperExpress from '@btc-vision/hyper-express';
import {
    getLatestFee, getFeeHistory, getRecentEvents,
    getToken, getTokens, getLatestOraclePrice, getAllLatestOraclePrices,
    getAddressOverview, getAddressTxs, getTxByHash,
} from './db.js';

const schema = buildSchema(`
  type Query {
    latestFee: Fee
    feeHistory(blocks: Int): [Fee]
    recentEvents(limit: Int, type: String): [ContractEvent]
    token(address: String!): Token
    tokens(limit: Int): [Token]
    oraclePrice(symbol: String): OraclePrice
    oraclePrices: [OraclePrice]
    address(address: String!): AddressOverview
    addressTxs(address: String!, limit: Int, cursor: Int): [ContractEvent]
    tx(hash: String!): [ContractEvent]
  }

  type Fee {
    block_height: Int
    median_fee_scaled: Int
    mempool_count: Int
    submitted_at: String
  }

  type ContractEvent {
    id: Int
    block_height: Int
    tx_hash: String
    contract_address: String
    event_type: String
    from_address: String
    ts: String
  }

  type Token {
    contract_address: String
    name: String
    symbol: String
    decimals: Int
    total_supply: String
  }

  type OraclePrice {
    id: Int
    symbol: String
    price: Float
    confidence: Float
    signature: String
    captured_at: String
  }

  type AddressOverview {
    tx_count: Int
    contracts_touched: Int
    first_seen_block: String
    last_seen_block: String
    total_events: Int
  }
`);

const rootValue = {
    latestFee:      () => getLatestFee(),
    feeHistory:     ({ blocks }: { blocks?: number }) => getFeeHistory(blocks ?? 50),
    recentEvents:   ({ limit, type }: { limit?: number; type?: string }) => getRecentEvents(limit ?? 20, type ?? null, null),
    token:          ({ address }: { address: string }) => getToken(address),
    tokens:         ({ limit }: { limit?: number }) => getTokens(limit ?? 20),
    oraclePrice:    ({ symbol }: { symbol?: string }) => getLatestOraclePrice(symbol ?? 'BTC/USD'),
    oraclePrices:   () => getAllLatestOraclePrices(),
    address:        ({ address }: { address: string }) => getAddressOverview(address),
    addressTxs:     ({ address, limit, cursor }: { address: string; limit?: number; cursor?: number }) => getAddressTxs(address, limit ?? 50, cursor ?? null),
    tx:             ({ hash }: { hash: string }) => getTxByHash(hash),
};

const gqlHandler = createHandler({ schema, rootValue });

export async function handleGraphQL(
    req: HyperExpress.Request,
    res: HyperExpress.Response,
): Promise<void> {
    // graphql-http expects Node.js IncomingMessage / ServerResponse
    // HyperExpress provides compatibility shims via raw accessors
    const nodeReq = (req as unknown as { raw: unknown }).raw;
    const nodeRes = (res as unknown as { raw: unknown }).raw;
    await gqlHandler(nodeReq as Parameters<typeof gqlHandler>[0], nodeRes as Parameters<typeof gqlHandler>[1]);
}
