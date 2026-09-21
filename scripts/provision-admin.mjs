import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { adminProvisionStatements } from './admin-provision-sql.mjs';

const [target, userId] = process.argv.slice(2);
if (!['--local', '--remote'].includes(target) || !userId || !/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
  throw new Error('Usage: node scripts/provision-admin.mjs --local|--remote VERIFIED_USER_ID');
}
// User IDs are validated above; no emails, passwords, or secret values are printed.
// Promotion also invalidates existing sessions. Authorization always reads the current role.
const sql = adminProvisionStatements(userId).join(';\n') + ';\n';
mkdirSync('.wrangler', { recursive: true });
const file = resolve('.wrangler/provision-admin.sql');
writeFileSync(file, sql);
const args = ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB', target, '--config', 'wrangler.jsonc', '--file', file];
if (target === '--local') args.push('--persist-to', '.wrangler/state');
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
