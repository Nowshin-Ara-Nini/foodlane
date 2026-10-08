import { z } from 'zod';
import { rateLimit } from './api-security';
import { type AppUser } from './permissions';
import { type PrivateEnvironment } from './private-verification';
import { type AuthEnvironment } from './auth';
import { deleteAccountData } from './verification-retention';

export const deletionReasons = ['not-using', 'privacy', 'too-difficult', 'technical-issues', 'switching', 'other'] as const;
export async function confirmDeletion(env:AuthEnvironment&PrivateEnvironment,user:AppUser,raw:unknown) {
  await rateLimit(env,'delete-confirm',user.userId,3,900);
  const data=z.object({confirmation:z.literal('DELETE'),reason:z.enum(deletionReasons).optional()}).strict().parse(raw);
  return deleteAccountData(env,user.userId,data.reason ?? null);
}
