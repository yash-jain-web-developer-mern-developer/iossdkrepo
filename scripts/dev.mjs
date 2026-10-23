// Local development server with an admin account and demo data (in-memory database: everything resets on restart).
//   node scripts/dev.mjs            ->  http://localhost:8080
// Test-only accounts. Never use these credentials or this script in production.
import { createApp } from '../src/server.js';
import { hashPw } from '../src/http.js';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const port = +process.env.PORT || 8080;
const app = await createApp({ port, publicUrl: `http://localhost:${port}` });
app.setPublicUrl(`http://localhost:${port}`);
await app.repo.createUser({ id: 'usr_dev_admin', email: 'admin@mobiad.test', role: 'admin', ...hashPw('Admin-Pass-Phrase-2026'), emailVerified: true });
app.server.listen(port, () => {
  console.log(`MobiAd dev server on http://localhost:${port}`);
  // async child: a synchronous call would block this very server while the seeder talks to it
  spawn(process.execPath, [fileURLToPath(new URL('./demo-seed.js', import.meta.url)), `http://localhost:${port}`], { stdio: 'inherit' });
});
