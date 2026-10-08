import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const user = sqliteTable('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  phone: text('phone'),
  role: text('role', { enum: ['buyer', 'seller', 'admin'] }).notNull().default('buyer'),
  roleChosen: integer('role_chosen', { mode: 'boolean' }).notNull().default(false),
  accountStatus: text('account_status', { enum: ['active', 'banned', 'deleting'] }).notNull().default('active'),
  banReason: text('ban_reason'),
  bannedAt: integer('banned_at'),
  bannedBy: text('banned_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
export const session = sqliteTable('auth_sessions', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  providerAccessToken: text('provider_access_token'),
  providerRefreshToken: text('provider_refresh_token'),
  providerExpiresAt: integer('provider_expires_at'),
}, t => [index('auth_sessions_user').on(t.userId)]);
export const account = sqliteTable('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [index('auth_accounts_user').on(t.userId), uniqueIndex('auth_accounts_provider').on(t.providerId, t.accountId)]);
export const verification = sqliteTable('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
}, t => [index('auth_verifications_identifier').on(t.identifier)]);

// Atomic counters shared across Worker isolates. Keys are HMACs, not IPs/emails.
export const authLimits = sqliteTable('auth_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, t => [index('auth_limits_expiry').on(t.expiresAt)]);
// Adds single-use enforcement to Better Auth's signed email verification links.
export const emailLinks = sqliteTable('auth_email_links', {
  digest: text('digest').primaryKey(),
  expiresAt: integer('expires_at').notNull(),
});

export const accountDeletionFeedback = sqliteTable('account_deletion_feedback', {
  id: text('id').primaryKey(),
  reason: text('reason').notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [index('idx_account_deletion_feedback_created').on(t.createdAt)]);

// No user foreign key: this job must survive identity/local account deletion.
export const accountDeletionJobs = sqliteTable('account_deletion_jobs', {
  userId: text('user_id').primaryKey(),
  providerRequired: integer('provider_required').notNull(),
  providerDeleted: integer('provider_deleted').notNull().default(0),
  requestedBy: text('requested_by'), feedbackReason: text('feedback_reason'),
  createdAt: integer('created_at').notNull(), attempts: integer('attempts').notNull().default(0),
  nextAttemptAt: integer('next_attempt_at').notNull().default(0), lastError: text('last_error'),
}, t => [index('account_deletion_jobs_due').on(t.nextAttemptAt)]);
export const cleanupHealth = sqliteTable('cleanup_health', {
  id: text('id').primaryKey(), startedAt: integer('started_at'), completedAt: integer('completed_at'),
  failedAt: integer('failed_at'), filesPending: integer('files_pending').notNull().default(0),
  accountsPending: integer('accounts_pending').notNull().default(0),
});
