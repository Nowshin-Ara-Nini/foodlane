import { env } from 'cloudflare:workers';
import { handleFoodlane } from '../../../../lib/foodlane-api';
import { authEnvironment } from '../../../auth-session';
async function handler(request: Request) {
  try { return await handleFoodlane(request, { ...authEnvironment(), BUCKET: env.BUCKET }); }
  catch { return Response.json({ error: 'Service is not configured.' }, { status: 503, headers: { 'Cache-Control': 'private, no-store' } }); }
}
export const GET = handler;
export const POST = handler;
