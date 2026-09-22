import { redirect } from 'next/navigation';
import { authEnvironment, requireUser } from '../../auth-session';
import { adminMfaVerified } from '../../../lib/admin-mfa';
import AdminMfa from './mfa-form';
export const dynamic='force-dynamic';
export const metadata={title:'Admin verification · Foodlane',robots:{index:false,follow:false},referrer:'no-referrer'};
export default async function MfaPage(){
  const user=await requireUser('/admin/mfa');
  if(user.role!=='admin'||!user.roleChosen)redirect('/forbidden');
  if(await adminMfaVerified(authEnvironment().DB,user))redirect('/admin');
  const factor=await authEnvironment().DB.prepare('SELECT enabled FROM admin_mfa WHERE user_id=?').bind(user.userId).first<{enabled:number}>();
  return <AdminMfa enrolled={!!factor?.enabled}/>;
}
