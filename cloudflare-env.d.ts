declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    PRIVATE_VERIFICATIONS?: R2Bucket;
    IMAGES?: ImagesBinding;
    NID_ENCRYPTION_KEYS?: string;
    NID_KEY_VERSION?: string;
    VERIFICATION_RETENTION_ENABLED?: string;
    VERIFICATION_RETENTION_DAYS?: string;
    AUTH_BASE_URL?: string;
    BETTER_AUTH_SECRET?: string;
    AUTH_ALLOW_LOCAL_HTTP?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    RESEND_API_KEY?: string;
    AUTH_EMAIL_FROM?: string;
  }
}
