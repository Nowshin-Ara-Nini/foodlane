import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, primaryKey, index, check } from 'drizzle-orm/sqlite-core';
import { sellers } from './schema';
import { user } from './auth-schema';

export const sellerInterests = sqliteTable('seller_interests', {
  sellerId: text('seller_id').notNull().references(() => sellers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  created: text('created').notNull(),
}, t => [primaryKey({ columns: [t.sellerId,t.userId] }),index('seller_interests_user').on(t.userId)]);
export const sellerReviews = sqliteTable('seller_reviews', {
  sellerId: text('seller_id').notNull().references(() => sellers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  name: text('name').notNull(), rating: integer('rating').notNull(), body: text('body').notNull(),
  created: text('created').notNull(), updated: text('updated').notNull(),
}, t => [primaryKey({ columns: [t.sellerId,t.userId] }),index('seller_reviews_user').on(t.userId),index('seller_reviews_recent').on(t.sellerId,t.created),check('seller_reviews_rating',sql`${t.rating} BETWEEN 1 AND 5`)]);

export const sellerRecommendations = sqliteTable('seller_recommendations', {
  sellerId: text('seller_id').notNull().references(() => sellers.id, { onDelete: 'cascade' }),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  created: text('created').notNull(),
}, t => [primaryKey({ columns: [t.sellerId,t.userId] }),index('seller_recommendations_user').on(t.userId)]);
