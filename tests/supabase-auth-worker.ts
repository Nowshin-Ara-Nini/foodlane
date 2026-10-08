import { handleSupabaseAuth } from '../lib/supabase-auth';
import type { AuthEnvironment } from '../lib/auth';

const user = { id:'google-user-1', email:'buyer@example.test', email_confirmed_at:new Date().toISOString(), user_metadata:{name:'Google Buyer',picture:'https://lh3.googleusercontent.com/avatar'} };
let refreshStatus=400,providerStatus=200;
const sessions = new Map<string,typeof user>();
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input:RequestInfo|URL, init?:RequestInit) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
  if (url.hostname !== 'supabase.test') return originalFetch(input,init);
  const body = init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : {};
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'pkce') {
    if(body.auth_code!=='google-code'||body.code_verifier===undefined)return Response.json({message:'invalid code'},{status:400});
    sessions.set('access-google-user-1',user);
    return Response.json({access_token:'access-google-user-1',refresh_token:'refresh-google-user-1',expires_in:3600,user});
  }
  if (url.pathname === '/auth/v1/user') {
    if(providerStatus!==200)return Response.json({message:'temporary'},{status:providerStatus});
    const access = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /,'');
    const found = access ? sessions.get(access) : null;
    return found ? Response.json(found) : Response.json({message:'invalid token'},{status:401});
  }
  if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token') return refreshStatus===200 ? Response.json({access_token:'access-google-user-1',refresh_token:'refreshed-token',expires_in:3600,user}) : Response.json({message:'refresh unavailable'},{status:refreshStatus});
  if (url.pathname === '/auth/v1/logout') return new Response(null,{status:204});
  return Response.json({message:'not mocked'},{status:404});
};

const worker = {
  async fetch(request:Request,env:AuthEnvironment) {
    if(new URL(request.url).pathname==='/test/provider'){const body=await request.json() as {refresh?:number;provider?:number};refreshStatus=body.refresh??400;providerStatus=body.provider??200;return Response.json({ok:true});}
    if (new URL(request.url).pathname.startsWith('/api/auth/')) return handleSupabaseAuth(request,env);
    return new Response('Not found',{status:404});
  },
};
export default worker;
