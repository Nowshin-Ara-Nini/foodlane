import { requirePageRole } from '../auth-session';
import AdminReview from './review-panel';
export const dynamic = 'force-dynamic';
export default async function Admin() {
  await requirePageRole('admin', '/admin');
  return <AdminReview/>;
}
