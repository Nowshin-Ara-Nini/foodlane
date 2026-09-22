import { requirePageRole, requireUser } from '../auth-session';
import AccountSettings from './settings';
export const dynamic='force-dynamic';
export default async function AccountPage(){
  const user=await requireUser('/account');
  if(user.role==='admin')await requirePageRole('admin','/account');
  return <AccountSettings/>;
}
