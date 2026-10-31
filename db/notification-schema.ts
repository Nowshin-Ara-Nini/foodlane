import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { user } from './auth-schema';

export const sellerNotifications = sqliteTable('seller_notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  message: text('message').notNull(),
  createdAt: text('created_at').notNull(),
  readAt: text('read_at'),
}, t => [index('seller_notifications_user_created').on(t.userId, t.createdAt), index('seller_notifications_user_read').on(t.userId, t.readAt)]);
