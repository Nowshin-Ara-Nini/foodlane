import { notFound } from 'next/navigation';
import AuthForm from '../auth-form';
export const metadata = { title: 'Account | Foodlane', referrer: 'no-referrer' };
const screens = ['login', 'signup', 'forgot-password', 'reset-password', 'verify', 'resend'] as const;
export default async function AuthPage({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  if (!screens.includes(screen as typeof screens[number])) notFound();
  return <AuthForm screen={screen as typeof screens[number]} />;
}
