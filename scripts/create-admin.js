// Create (or reset the password of) an admin account. Admins can never be created through public signup.
//   DATABASE_URL=... ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='long passphrase' node scripts/create-admin.js
// Then log in and enable two-step login (required for admin APIs in production).
import { randomBytes } from 'node:crypto';
import { createPool, Repo } from '../src/db/repo.js';
import { hashPw } from '../src/http.js';
import { passwordProblem } from '../src/api/util.js';

const { DATABASE_URL, ADMIN_EMAIL, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) { console.error('DATABASE_URL, ADMIN_EMAIL and ADMIN_PASSWORD are required'); process.exit(1); }
const problem = passwordProblem(ADMIN_PASSWORD, ADMIN_EMAIL);
if (problem) { console.error('Weak password: ' + problem); process.exit(1); }

const repo = new Repo(await createPool(DATABASE_URL));
await repo.migrate();
const email = ADMIN_EMAIL.trim().toLowerCase(), existing = await repo.userByEmail(email), h = hashPw(ADMIN_PASSWORD);
if (existing) {
  if (existing.role !== 'admin') { console.error(`${email} exists as a ${existing.role}; refusing to change its role`); process.exit(1); }
  await repo.setPassword(existing.id, h.salt, h.hash);
  await repo.audit({ actor: 'cli', action: 'admin_password_reset', target: existing.id });
  console.log('admin password updated (all sessions revoked)');
} else {
  const id = 'usr_' + randomBytes(8).toString('hex');
  await repo.createUser({ id, email, role: 'admin', salt: h.salt, hash: h.hash, emailVerified: true });
  await repo.audit({ actor: 'cli', action: 'admin_created', target: id });
  console.log('admin created:', email);
}
await repo.close();
