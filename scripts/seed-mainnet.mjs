import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../.env');

const raw = readFileSync(envPath, 'utf8');
const env = Object.fromEntries(
  raw.split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => [l.split('=')[0].trim(), l.split('=').slice(1).join('=').trim()])
);

const dbUrl = process.env.DATABASE_URL || env.DATABASE_URL;
if (!dbUrl) { console.error('No DATABASE_URL found'); process.exit(1); }

const p = new pg.Pool({ connectionString: dbUrl });

console.log('Truncating testnet data...');
await p.query('TRUNCATE block_activity, contract_events, tokens RESTART IDENTITY CASCADE');

console.log('Seeding at block 945000...');
await p.query('INSERT INTO block_activity(block_height,events_count,tx_count,contract_calls) VALUES(945000,0,0,0)');

await p.end();
console.log('Done — restart blockfeed now');
