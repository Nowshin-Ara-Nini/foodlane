import { getUser } from '../../auth-session';
export async function GET() {
  const user = await getUser();
  if (!user || user.role !== 'admin' || !user.roleChosen) return new Response('Admin access required.', { status: 403 });
  return new Response('Use the admin document route with a submission ID.', { status: 410, headers: { 'Cache-Control': 'private, no-store' } });
}
