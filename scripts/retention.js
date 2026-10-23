// Data-retention job: removes data that outlived its purpose. Run daily (see infra/k8s/base/retention-cronjob.yaml).
//   DATABASE_URL=... [RETENTION_TOKENS_DAYS=30] [RETENTION_AUDIT_DAYS=400] node scripts/retention.js
// NEVER touches the billing ledger: financial records are retained for the legal period (typically 6-7 years; confirm with counsel).
import { createPool, Repo } from '../src/db/repo.js';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
const repo = new Repo(await createPool(process.env.DATABASE_URL));
const r = await repo.purgeExpired({ tokensOlderThanDays: +process.env.RETENTION_TOKENS_DAYS || 30, auditOlderThanDays: +process.env.RETENTION_AUDIT_DAYS || 400 });
console.log(JSON.stringify({ at: new Date().toISOString(), removed: r }));
await repo.close();
