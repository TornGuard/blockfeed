import 'dotenv/config';

export const CONFIG = {
  port:        Number(process.env.PORT) || 3001,
  databaseUrl: process.env.DATABASE_URL,
  adminKey:    process.env.ADMIN_KEY,
};

if (!CONFIG.databaseUrl) {
  console.error('[BlockFeed] ERROR: DATABASE_URL is required');
  process.exit(1);
}

if (!CONFIG.adminKey) {
  console.warn('[BlockFeed] WARNING: ADMIN_KEY not set — admin endpoints are disabled');
}
