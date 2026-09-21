import { redirect } from 'next/navigation';
import { requireUser } from '../../auth-session';
import { safeReturnPath } from '../../../lib/auth-policy';
import ChooseRole from './role-form';
export const dynamic = 'force-dynamic';
export default async function RolePage({ searchParams }: { searchParams: Promise<{ returnTo?: string }> }) {
  const user = await requireUser('/auth/choose-role');
  const returnTo = safeReturnPath((await searchParams).returnTo);
  if (user.roleChosen) redirect(returnTo === '/' && user.role === 'seller' ? '/seller' : returnTo);
  return <ChooseRole returnTo={returnTo} />;
}
