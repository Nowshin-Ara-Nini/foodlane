import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir,writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashPassword } from 'better-auth/crypto';

const account=process.argv[2];
if(!/^[a-f0-9]{32}$/.test(account??''))throw Error('Usage: node scripts/hash-benchmark.mjs CLOUDFLARE_ACCOUNT_ID');
const directory=resolve('.wrangler/hash-benchmark');await mkdir(directory,{recursive:true});
const name=`foodlane-hash-${Date.now().toString(36)}`,config=resolve(directory,'wrangler.json');
await writeFile(config,JSON.stringify({name,account_id:account,main:resolve('scripts/hash-benchmark-worker.ts'),compatibility_date:'2026-05-15',compatibility_flags:['nodejs_compat'],workers_dev:true,preview_urls:false,observability:{enabled:false}},null,2));
const token=randomBytes(32).toString('hex');
const password='Synthetic runtime benchmark only, not a user password 2026';
const verifyHash=await hashPassword(password);
function wrangler(args,input){
  const result=spawnSync(process.execPath,['--import','./scripts/sites-env.mjs','./node_modules/wrangler/bin/wrangler.js',...args,'--config',config],{encoding:'utf8',input,env:{...process.env,CI:'1'}});
  // The token only goes to stdin; never print input, headers or raw invocation logs.
  if(result.error)throw result.error;
  if(result.status!==0)throw Error((result.stderr||result.stdout).replaceAll(token,'[redacted]').replaceAll(verifyHash,'[redacted]'));
  return result.stdout;
}
let deploymentAttempted=false;
const report={name,createdAt:new Date().toISOString(),plan:'Free (owner-confirmed)',samples:[],cpuMetrics:'Not obtained; wall latency is not CPU time.',removed:false};
try{
  deploymentAttempted=true;
  const deployment=wrangler(['deploy']);
  const url=deployment.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/)?.[0];
  if(!url)throw Error('No workers.dev URL was returned. Configure an account subdomain in Cloudflare.');
  report.url=url;
  wrangler(['secret','put','BENCHMARK_TOKEN','--name',name],`${token}\n`);
  wrangler(['secret','put','BENCHMARK_HASH','--name',name],`${verifyHash}\n`);
  const secrets=JSON.parse(wrangler(['secret','list','--name',name]));
  if(!Array.isArray(secrets)||!['BENCHMARK_TOKEN','BENCHMARK_HASH'].every(key=>secrets.some(secret=>secret.name===key)))throw Error('Wrangler did not bind the temporary probe secrets.');
  console.log('Protected probe secret bindings verified by name.');
  console.log(`Protected probe deployed: ${url}`);
  // Exercise the separate operations used by signup/reset and login.
  for(const operation of ['hash','verify']){
    const samples=[];
    for(let i=0;i<25;i++){
      const start=performance.now();
      const response=await fetch(`${url}/${operation}`,{method:'POST',headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(30000)});
      const body=await response.text();
      const outcome={operation,status:response.status,resourceLimit:/1102|exceeded.*(?:resource|CPU)/i.test(body),valid:response.status===200&&body.includes('"valid":true'),wallMs:Math.round(performance.now()-start)};
      samples.push(outcome);report.samples.push(outcome);
      console.log(`${operation} sample ${i+1}: HTTP ${outcome.status}${outcome.resourceLimit?' resource limit':''}, ${outcome.wallMs} ms wall time`);
    }
    report[operation]={samples:samples.length,passed:samples.filter(s=>s.valid).length,resourceLimitFailures:samples.filter(s=>s.resourceLimit).length};
  }
  if(report.hash.passed!==report.hash.samples||report.verify.passed!==report.verify.samples)throw Error('At least one hashing operation did not complete successfully.');
}catch(error){report.error=error instanceof Error?error.message:'Benchmark failed';console.error(report.error);process.exitCode=1;}
finally{
  // A failed publish can still leave a partially uploaded script, so clean up
  // after every attempted deploy, not only after Wrangler returns success.
  if(deploymentAttempted){try{wrangler(['delete','--name',name,'--force']);report.removed=true;console.log('Temporary benchmark Worker removed.');}catch{report.cleanupRequired=true;console.error(`Manual cleanup required for temporary Worker ${name}.`);process.exitCode=1;}}
  await writeFile(resolve(directory,'result.json'),JSON.stringify(report,null,2));
}
