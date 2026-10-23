// Rebuild campaigns.impressions/clicks/spent from the ledger: DATABASE_URL=... node scripts/reconcile.js
import { createPool, Repo } from '../src/db/repo.js';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
const repo = new Repo(await createPool(process.env.DATABASE_URL));
console.log('campaigns reconciled:', await repo.reconcileCounters());
await repo.close();
