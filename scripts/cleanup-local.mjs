import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve('wrangler/package.json'));
const { Miniflare } = wranglerRequire('miniflare');
const config = JSON.parse(await readFile('dist/server/wrangler.json','utf8'));
const paths = (await readdir('dist/server',{recursive:true})).filter(p=>p.endsWith('.js') && p!==config.main);
const modules = [config.main,...paths].map(path=>({type:'ESModule',path:resolve('dist/server',path)}));
// Dispatch directly to the built Worker. The pinned Wrangler asset-proxy preview
// does not forward scheduled events (workers-sdk issue #9882).
const mf = new Miniflare({
  name:'cleanup-local', modules,
  modulesRoot:resolve('dist/server'), modulesRules:[{type:'ESModule',include:['**/*.js']}],
  compatibilityDate:config.compatibility_date, compatibilityFlags:config.compatibility_flags,
  d1Databases:Object.fromEntries(config.d1_databases.map(b=>[b.binding,b.database_id])),
  d1Persist:resolve('.wrangler/state/v3/d1'),
  r2Buckets:Object.fromEntries(config.r2_buckets.map(b=>[b.binding,b.bucket_name])),
  r2Persist:resolve('.wrangler/state/v3/r2'),
});
try {
  const result=await (await mf.getWorker()).scheduled({cron:'0 3 * * *'});
  if(result.outcome!=='ok')throw new Error('Scheduled cleanup failed.');
  const db=await mf.getD1Database('DB');
  const counts=await db.prepare('SELECT COUNT(*) pending FROM verification_files WHERE object_key IS NOT NULL AND delete_after IS NOT NULL').first();
  console.log(JSON.stringify({scheduled:result.outcome,...counts}));
} finally { await mf.dispose(); }
