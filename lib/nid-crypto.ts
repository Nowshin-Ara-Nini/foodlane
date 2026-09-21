import { HttpError } from './permissions';
export interface EncryptionEnvironment { NID_ENCRYPTION_KEYS?: string; NID_KEY_VERSION?: string }
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
function decode(value: string) { return Uint8Array.from(atob(value), c => c.charCodeAt(0)); }
async function key(env: EncryptionEnvironment, version: string) {
  try {
    const keys = JSON.parse(env.NID_ENCRYPTION_KEYS ?? '{}') as Record<string, string>;
    const bytes = decode(keys[version]);
    if (bytes.length !== 32) throw new Error();
    return await crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  } catch { throw new HttpError(503, 'Verification encryption is unavailable.'); }
}
export async function encryptNid(env: EncryptionEnvironment, value: string, submissionId: string) {
  const version = env.NID_KEY_VERSION ?? 'v1', secret = await key(env, version);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(submissionId) }, secret, new TextEncoder().encode(value));
  return { ciphertext: encode(new Uint8Array(ciphertext)), iv: encode(iv), version };
}
export async function decryptNid(env: EncryptionEnvironment, record: { id: string; nid_ciphertext: string; nid_iv: string; nid_key_version: string }) {
  const secret = await key(env, record.nid_key_version);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(record.nid_iv), additionalData: new TextEncoder().encode(record.id) }, secret, decode(record.nid_ciphertext));
  return new TextDecoder().decode(plaintext);
}
