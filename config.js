import 'dotenv/config';

export const CONFIG = {
  port: Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL,
};

if (!CONFIG.databaseUrl) {
  console.error('[BlockFeed] ERROR: DATABASE_URL is required');
  process.exit(1);
}
