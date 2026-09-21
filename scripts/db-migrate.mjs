import { spawnSync } from 'node:child_process';
const target = process.argv[2];
if (!['--local', '--remote'].includes(target)) throw new Error('Use --local or --remote.');
const args = ['--import', './scripts/sites-env.mjs', './node_modules/wrangler/bin/wrangler.js', 'd1', 'migrations', 'apply', 'DB', target, '--config', 'wrangler.jsonc'];
if (target === '--local') args.push('--persist-to', '.wrangler/state');
const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
