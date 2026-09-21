import { authEnvironment } from '../../../auth-session';
import { handleAuth } from '../../../../lib/auth-handler';

async function handler(request: Request) {
  try { return await handleAuth(request, authEnvironment()); }
  catch { return Response.json({ error: 'Authentication is not configured.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
export const GET = handler;
export const POST = handler;
