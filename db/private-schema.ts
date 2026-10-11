import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const sellerVerifications = sqliteTable('seller_verifications', {
  id: text('id').primaryKey(), sellerId: text('seller_id').notNull(),
  legalName: text('legal_name').notNull(), age: integer('age'), gender: text('gender'),
  personalEmail: text('personal_email').notNull(), personalPhone: text('personal_phone').notNull(), homeAddress: text('home_address'),
  nidCiphertext: text('nid_ciphertext'), nidIv: text('nid_iv'), nidKeyVersion: text('nid_key_version'),
  placeAddress: text('place_address'), placeLat: real('place_lat'), placeLng: real('place_lng'),
  note: text('note'), status: text('status').notNull().default('pending'), created: text('created').notNull(),
  locationNoticeVersion: text('location_notice_version').notNull(), locationAcceptedAt: text('location_accepted_at').notNull(),
  portraitConsent: integer('portrait_consent').notNull().default(0), portraitConsentAt: text('portrait_consent_at'), portraitWithdrawnAt: text('portrait_withdrawn_at'),
  reviewedBy: text('reviewed_by'), reviewedAt: text('reviewed_at'), decisionNote: text('decision_note'), decisionId: text('decision_id'),
  retentionDueAt: text('retention_due_at'), reviewDetailsPurgedAt: text('review_details_purged_at'),
}, t => [index('idx_private_verification_seller').on(t.sellerId, t.created), uniqueIndex('idx_one_pending_submission').on(t.sellerId).where(sql`${t.status} = 'pending'`)]);

// Keys live only here. Rows with delete_after are durable, retryable deletion jobs.
// Staging jobs are written BEFORE R2 so failed uploads never become untracked files.
export const verificationFiles = sqliteTable('verification_files', {
  id: text('id').primaryKey(), subject: text('subject').notNull(), submissionId: text('submission_id'),
  kind: text('kind').notNull(), bucket: text('bucket').notNull(), objectKey: text('object_key'),
  state: text('state').notNull(), createdAt: text('created_at').notNull(), deleteAfter: text('delete_after'),
  deletedAt: text('deleted_at'), attempts: integer('attempts').notNull().default(0), nextAttemptAt: text('next_attempt_at'),
}, t => [index('idx_file_cleanup').on(t.deleteAfter, t.nextAttemptAt), index('idx_file_subject').on(t.subject), index('idx_file_submission').on(t.submissionId, t.kind)]);

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(), subject: text('subject').notNull(), action: text('action').notNull(),
  adminRef: text('admin_ref'), createdAt: text('created_at').notNull(),
}, t => [index('idx_audit_time').on(t.createdAt), index('idx_audit_subject').on(t.subject)]);
