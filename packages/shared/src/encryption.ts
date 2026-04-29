/**
 * Envelope encryption for customer DB credentials.
 *
 * Two-layer scheme:
 *   1. Generate a random 32-byte DEK (data encryption key) per record.
 *   2. Encrypt plaintext credentials with the DEK using AES-256-GCM.
 *   3. Encrypt the DEK with the master key using AES-256-GCM.
 *   4. Store the ciphertext + encrypted DEK + a key version.
 *
 * The DEK never persists in plaintext. The master key only lives in
 * Cloudflare Secrets Store. AAD = `tenant_id||db_profile_id` so a
 * swapped row from another tenant won't decrypt cleanly.
 *
 * Output format (single Uint8Array):
 *   ciphertext:   [iv:12][ciphertext+tag:N]   ← AES-GCM appends a 16-byte tag
 *   encryptedDek: [iv:12][ciphertext+tag:48]  ← 32-byte DEK + 16-byte tag
 */

const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_VERSION = 1;

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

function decodeBase64Key(key: string): Uint8Array {
  // Accept base64; if it's not, treat as raw bytes (e.g. dev/test).
  if (/^[A-Za-z0-9+/=]+$/.test(key)) {
    try {
      return Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
    } catch {
      // fall through
    }
  }
  return utf8(key);
}

// Helper: ensure a Uint8Array has a backing ArrayBuffer (not SharedArrayBuffer),
// which is what crypto.subtle expects per the strict WebCrypto types in TS 5.
function toAB(u: Uint8Array): ArrayBuffer {
  // .slice() always returns a fresh ArrayBuffer-backed Uint8Array.
  const fresh = u.slice();
  return fresh.buffer as ArrayBuffer;
}

async function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  if (rawKey.byteLength !== KEY_BYTES) {
    throw new Error(`encryption key must be exactly ${KEY_BYTES} bytes (got ${rawKey.byteLength})`);
  }
  return crypto.subtle.importKey("raw", toAB(rawKey), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function aesGcmEncrypt(
  key: CryptoKey,
  plaintext: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toAB(iv), additionalData: toAB(aad) },
      key,
      toAB(plaintext)
    )
  );
  const out = new Uint8Array(IV_BYTES + ct.byteLength);
  out.set(iv, 0);
  out.set(ct, IV_BYTES);
  return out;
}

async function aesGcmDecrypt(
  key: CryptoKey,
  payload: Uint8Array,
  aad: Uint8Array
): Promise<Uint8Array> {
  const iv = payload.slice(0, IV_BYTES);
  const ct = payload.slice(IV_BYTES);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toAB(iv), additionalData: toAB(aad) },
    key,
    toAB(ct)
  );
  return new Uint8Array(pt);
}

export type CredentialBundle = Record<string, unknown>;

export interface EncryptedRecord {
  ciphertext: Uint8Array;
  encryptedDek: Uint8Array;
  keyVersion: number;
}

export interface AAD {
  tenantId: string;
  dbProfileId: string;
}

function aadBytes(aad: AAD): Uint8Array {
  return utf8(`${aad.tenantId}|${aad.dbProfileId}`);
}

/**
 * Encrypt a credential bundle. Returns ciphertext + encrypted DEK
 * suitable for storing in two `bytea` columns.
 */
export async function encryptCredentials(
  masterKeyB64: string,
  plaintext: CredentialBundle,
  aad: AAD
): Promise<EncryptedRecord> {
  const masterKey = await importKey(decodeBase64Key(masterKeyB64));
  const dek = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const dekKey = await importKey(dek);

  const adBytes = aadBytes(aad);
  const ciphertext = await aesGcmEncrypt(dekKey, utf8(JSON.stringify(plaintext)), adBytes);
  const encryptedDek = await aesGcmEncrypt(masterKey, dek, adBytes);

  // Zero out the DEK from memory ASAP.
  dek.fill(0);

  return { ciphertext, encryptedDek, keyVersion: KEY_VERSION };
}

/** Decrypt a credential bundle. Throws if AAD doesn't match (cross-tenant defence). */
export async function decryptCredentials(
  masterKeyB64: string,
  record: EncryptedRecord,
  aad: AAD
): Promise<CredentialBundle> {
  const masterKey = await importKey(decodeBase64Key(masterKeyB64));
  const adBytes = aadBytes(aad);

  const dek = await aesGcmDecrypt(masterKey, record.encryptedDek, adBytes);
  const dekKey = await importKey(dek);
  const plaintext = await aesGcmDecrypt(dekKey, record.ciphertext, adBytes);
  dek.fill(0);

  return JSON.parse(utf8Decode(plaintext)) as CredentialBundle;
}

/** Convenience: generate a fresh 32-byte master key as base64. */
export function generateMasterKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
