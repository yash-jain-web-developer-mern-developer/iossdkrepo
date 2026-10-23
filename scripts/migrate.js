// Deploy-time migration job: DATABASE_URL=... node scripts/migrate.js
import { createPool, Repo } from '../src/db/repo.js';
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL required'); process.exit(1); }
const repo = new Repo(await createPool(process.env.DATABASE_URL));
await repo.migrate();
console.log('migrations applied');
await repo.close();
