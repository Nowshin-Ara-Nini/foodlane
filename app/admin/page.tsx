import { redirect } from 'next/navigation';
import { requirePageRole } from '../auth-session';
export const dynamic = 'force-dynamic';
export default async function Admin() {
  await requirePageRole('admin', '/admin');
  redirect('/review');
}
