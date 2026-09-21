import { readFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
// Only development settings. Never print secret values or overwrite an existing key.
let existing;
try { existing = await readFile('.dev.vars','utf8'); }
catch { throw new Error('Create .dev.vars using .dev.vars.example and configure authentication first.'); }
if (!/^NID_ENCRYPTION_KEYS=/m.test(existing)) {
  const keys = JSON.stringify({ v1: randomBytes(32).toString('base64') });
  await appendFile('.dev.vars', `\nNID_ENCRYPTION_KEYS='${keys}'\nNID_KEY_VERSION=v1\nVERIFICATION_RETENTION_ENABLED=true\nVERIFICATION_RETENTION_DAYS=30\n`);
  console.log('Added development-only encryption key and default retention. Secret values were not printed.');
} else console.log('Existing development encryption configuration preserved.');
