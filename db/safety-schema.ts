import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sellers } from './schema';
import { user, session } from './auth-schema';

export const sellerReports = sqliteTable('seller_reports', {
  id: text('id').primaryKey(), sellerId: text('seller_id').notNull().references(()=>sellers.id,{onDelete:'cascade'}),
  userId: text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}), reason: text('reason').notNull(),
  status: text('status').notNull().default('open'), created: text('created').notNull(),
  resolvedAt: text('resolved_at'), resolution: text('resolution'), decisionId: text('decision_id'),
},t=>[index('reports_queue').on(t.status,t.created),uniqueIndex('reports_open_pair').on(t.sellerId,t.userId).where(sql`${t.status}='open'`)]);
export const sellerSuspensions = sqliteTable('seller_suspensions', {
  sellerId: text('seller_id').primaryKey().references(()=>sellers.id,{onDelete:'cascade'}),
  reason: text('reason').notNull(), created: text('created').notNull(),
});
export const deletionChallenges = sqliteTable('deletion_challenges', {
  sessionId: text('session_id').primaryKey().references(()=>session.id,{onDelete:'cascade'}),
  userId: text('user_id').notNull().references(()=>user.id,{onDelete:'cascade'}),
  digest: text('digest').notNull(), expiresAt: integer('expires_at').notNull(),
},t=>[index('deletion_challenges_expiry').on(t.expiresAt)]);
