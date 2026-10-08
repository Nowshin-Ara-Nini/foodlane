import { notFound } from 'next/navigation';
import AuthForm from '../auth-form';
export const metadata = { title: 'Account | Foodlane', referrer: 'no-referrer' };
const screens = ['login', 'signup'] as const;
export default async function AuthPage({ params, searchParams }: { params: Promise<{ screen: string }>; searchParams: Promise<{error?:string}> }) {
  const { screen } = await params;
  if (!screens.includes(screen as typeof screens[number])) notFound();
  return <AuthForm screen={screen as typeof screens[number]} initialError={(await searchParams).error} />;
}
