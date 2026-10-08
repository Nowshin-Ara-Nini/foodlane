// Temporary, token-protected runtime probe. Never part of the Foodlane app Worker.
import { hashPassword, verifyPassword } from 'better-auth/crypto';
const benchmarkWorker = {
  async fetch(request:Request,env:{BENCHMARK_TOKEN?:string;BENCHMARK_HASH?:string}) {
    if(!env.BENCHMARK_TOKEN)return new Response('Probe secret missing',{status:500});
    if(request.headers.get('authorization')!==`Bearer ${env.BENCHMARK_TOKEN}`)return new Response('Forbidden',{status:403});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    const path=new URL(request.url).pathname;
    const password='Synthetic runtime benchmark only, not a user password 2026';
    if(path==='/hash'){
      const hash=await hashPassword(password);
      return Response.json({valid:/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(hash)},{headers:{'Cache-Control':'no-store'}});
    }
    if(path==='/verify'&&env.BENCHMARK_HASH){
      const valid=await verifyPassword({hash:env.BENCHMARK_HASH,password});
      return Response.json({valid},{headers:{'Cache-Control':'no-store'}});
    }
    return new Response('Unknown probe operation',{status:404});
  },
};
export default benchmarkWorker;
