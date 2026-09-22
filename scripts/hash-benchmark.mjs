import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const account=process.argv[2];
if(!/^[a-f0-9]{32}$/.test(account??''))throw Error('Usage: node scripts/hash-benchmark.mjs CLOUDFLARE_ACCOUNT_ID');
const directory=resolve('.wrangler/hash-benchmark');await mkdir(directory,{recursive:true});
const name=`foodlane-hash-${Date.now().toString(36)}`,config=resolve(directory,'wrangler.json');
await writeFile(config,JSON.stringify({name,account_id:account,main:resolve('scripts/hash-benchmark-worker.ts'),compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,observability:{enabled:false}},null,2));
const token=randomBytes(32).toString('hex');
function wrangler(args,input){
  const result=spawnSync(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js',...args,'--config',config],{encoding:'utf8',input,env:{...process.env,CI:'1'}});
  // The token only goes to stdin; never print input, headers or raw invocation logs.
  if(result.error)throw result.error;
  if(result.status!==0)throw Error((result.stderr||result.stdout).replaceAll(token,'[redacted]'));
  return result.stdout;
}
let deployed=false;
const report={name,createdAt:new Date().toISOString(),plan:'Free (owner-confirmed)',samples:[],cpuMetrics:'Not obtained; wall latency is not CPU time.',removed:false};
try{
  const deployment=wrangler(['deploy']);deployed=true;
  const url=deployment.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if(!url)throw Error('No workers.dev URL was returned. Configure an account subdomain in Cloudflare.');
  report.url=url;
  wrangler(['secret','put','BENCHMARK_TOKEN'],token);
  console.log(`Protected probe deployed: ${url}`);
  // Distribute synthetic samples; no credentials, users, buckets or D1 are involved.
  for(let i=0;i<20;i++){
    const start=performance.now();
    const response=await fetch(url,{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
    const body=await response.text();
    const outcome={status:response.status,resourceLimit:/1102|exceeded.*(?:resource|CPU)/i.test(body),valid:response.status===200&&body.includes('"valid":true'),wallMs:Math.round(performance.now()-start)};
    report.samples.push(outcome);console.log(`Sample ${i+1}: HTTP ${outcome.status}${outcome.resourceLimit?' resource limit':''}, ${outcome.wallMs} ms wall time`);
  }
}catch(error){report.error=error instanceof Error?error.message:'Benchmark failed';console.error(report.error);process.exitCode=1;}
finally{
  if(deployed){try{wrangler(['delete','--name',name,'--force']);report.removed=true;console.log('Temporary benchmark Worker removed.');}catch{report.cleanupRequired=true;console.error(`Manual cleanup required for temporary Worker ${name}.`);process.exitCode=1;}}
  await writeFile(resolve(directory,'result.json'),JSON.stringify(report,null,2));
}
