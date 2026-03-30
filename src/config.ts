/**
 * BlockFeed server configuration.
 * All secrets come from environment variables — never hardcoded.
 */

import 'dotenv/config';

export interface BlockFeedConfig {
    readonly port: number;
    readonly databaseUrl: string;
    readonly adminKey: string;
    readonly oraclePrivateKey: string;
    readonly opnetRpcUrl: string;
    readonly devMode: boolean;
}

export const Config: BlockFeedConfig = {
    port:             Number(process.env['PORT'] ?? 3001),
    databaseUrl:      process.env['DATABASE_URL'] ?? '',
    adminKey:         process.env['ADMIN_KEY'] ?? '',
    oraclePrivateKey: process.env['ORACLE_PRIVATE_KEY'] ?? '',
    opnetRpcUrl:      process.env['OPNET_RPC_URL'] ?? 'https://testnet.opnet.org/api/v1/json-rpc',
    devMode:          process.env['NODE_ENV'] === 'development',
};
