declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    AUTH_BASE_URL?: string;
    BETTER_AUTH_SECRET?: string;
    AUTH_ALLOW_LOCAL_HTTP?: string;
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    RESEND_API_KEY?: string;
    AUTH_EMAIL_FROM?: string;
  }
}
