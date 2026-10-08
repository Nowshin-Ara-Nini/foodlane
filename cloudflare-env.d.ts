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
    SUPABASE_URL?: string;
    SUPABASE_PUBLISHABLE_KEY?: string;
    SUPABASE_SECRET_KEY?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: string;
    TEST_ONLY_BETTER_AUTH?: string;
  }
}
