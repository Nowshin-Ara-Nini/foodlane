export function authOrigin(value: string, allowLocal: boolean): string {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('AUTH_BASE_URL must be an origin.');
  }
  if (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) {
    throw new Error('HTTPS is required.');
  }
  return url.origin;
}

export function safeReturnPath(value: string | null | undefined): string {
  if (!value?.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://foodlane.invalid');
    if (url.origin !== 'https://foodlane.invalid' || url.pathname.startsWith('/api/auth') || url.pathname.startsWith('/auth')) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}

export async function digestToken(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
