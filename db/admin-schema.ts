import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
import { user, session } from './auth-schema';
export const adminMfa = sqliteTable('admin_mfa', {
  userId:text('user_id').primaryKey().references(()=>user.id,{onDelete:'cascade'}),
  secret:text('secret').notNull(), enabled:integer('enabled').notNull().default(0),
  setupSession:text('setup_session').notNull(), setupExpires:integer('setup_expires').notNull(),
  lastCounter:integer('last_counter').notNull().default(-1), proofId:text('proof_id'),
});
export const adminMfaSessions = sqliteTable('admin_mfa_sessions', {
  sessionId:text('session_id').primaryKey().references(()=>session.id,{onDelete:'cascade'}),
  userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  verifiedAt:integer('verified_at').notNull(), expiresAt:integer('expires_at').notNull(), proofId:text('proof_id').notNull(),
},t=>[index('idx_admin_mfa_user').on(t.userId)]);
export const adminRecoveryCodes = sqliteTable('admin_recovery_codes', {
  digest:text('digest').primaryKey(), userId:text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
},t=>[index('idx_recovery_user').on(t.userId)]);
