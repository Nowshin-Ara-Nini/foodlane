// Temporary, token-protected runtime probe. Never part of the Foodlane app Worker.
import { hashPassword, verifyPassword } from 'better-auth/crypto';
export default {
  async fetch(request:Request,env:{BENCHMARK_TOKEN?:string}) {
    if(!env.BENCHMARK_TOKEN||request.headers.get('authorization')!==`Bearer ${env.BENCHMARK_TOKEN}`)return new Response('Forbidden',{status:403});
    if(request.method!=='POST')return new Response('Method not allowed',{status:405});
    const password='Synthetic runtime benchmark only, not a user password 2026';
    const hash=await hashPassword(password);
    const valid=await verifyPassword({hash,password});
    return Response.json({valid},{headers:{'Cache-Control':'no-store'}});
  },
};
