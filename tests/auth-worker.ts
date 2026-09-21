// Test-only Worker: never referenced by the application deployment configuration.
import { createAuth, type AuthEnvironment, type AuthMail } from '../lib/auth';
import { handleAuth } from '../lib/auth-handler';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
const mail: AuthMail[] = [];
const worker = {
  async fetch(request: Request, env: AuthEnvironment) {
    const path = new URL(request.url).pathname;
    if (path === '/test/mail') return Response.json(mail.splice(0));
    if (path === '/test/hash') {
      const hash = await hashPassword('Benchmark-only password 2026');
      return Response.json({ valid: await verifyPassword({ hash, password: 'Benchmark-only password 2026' }) });
    }
    return handleAuth(request, env, createAuth(env, async (message) => { mail.push(message); }));
  },
};
export default worker;
