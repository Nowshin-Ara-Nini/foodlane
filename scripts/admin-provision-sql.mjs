export function adminProvisionStatements(userId) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(userId ?? '')) throw new Error('Invalid account ID.');
  return [
    `UPDATE auth_users SET role='admin', role_chosen=1, updated_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE id='${userId}' AND email_verified=1`,
    `DELETE FROM auth_sessions WHERE user_id='${userId}' AND EXISTS(SELECT 1 FROM auth_users WHERE id='${userId}' AND role='admin' AND email_verified=1)`,
    `SELECT CASE WHEN EXISTS(SELECT 1 FROM auth_users WHERE id='${userId}' AND role='admin' AND email_verified=1) THEN 'Admin provisioned; sign in again. Enroll or verify your authenticator at /admin/mfa.' ELSE 'No verified account matched; nothing was promoted.' END AS result`,
  ];
}
