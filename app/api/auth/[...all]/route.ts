import { authEnvironment } from '../../../auth-session';
import { handleSupabaseAuth } from '../../../../lib/supabase-auth';

async function handler(request: Request) {
  try { return await handleSupabaseAuth(request, authEnvironment()); }
  catch { return Response.json({ error: 'Authentication is not configured.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
export const GET = handler;
export const POST = handler;
