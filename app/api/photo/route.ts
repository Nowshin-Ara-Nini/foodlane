// Replaced by purpose-specific, server-authorized API routes.
function retired() { return Response.json({ error: 'This endpoint has been retired.' }, { status: 410, headers: { 'Cache-Control': 'private, no-store' } }); }
export const GET = retired;
export const POST = retired;