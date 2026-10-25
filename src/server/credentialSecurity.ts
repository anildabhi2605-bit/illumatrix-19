import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * ILLUMATRIX Credential Security & Encryption at Rest Engine
 * 
 * Cryptographic Standard:
 * - Cipher: AES-256-GCM (Authenticated Encryption with Associated Data - AEAD)
 * - Key Derivation: RFC 5869 HKDF using SHA-256 (32-byte key)
 * - Nonce/IV: 12 bytes cryptographically secure random bytes per encryption
 * - Authentication Tag: 16 bytes (128-bit) integrity and authenticity tag
 * - Serialization Format: enc:v1:<base64-iv>:<base64-tag>:<base64-ciphertext>
 */

export class MasterKeyMissingError extends Error {
  public readonly code = 'MASTER_KEY_MISSING';
  public readonly category = 'CONFIG_MISSING';
  public readonly status = 500;

  constructor(message?: string) {
    super(
      message ||
        'Cannot perform cryptographic operation: ILLUMATRIX_ENCRYPTION_KEY is not configured in the environment.'
    );
    this.name = 'MasterKeyMissingError';
  }
}

export class DecryptionFailedError extends Error {
  public readonly code = 'DECRYPTION_FAILED';
  public readonly category = 'AUTH_FAILED';
  public readonly status = 500;

  constructor(message?: string) {
    super(message || 'Failed to decrypt credential at rest: invalid key, altered ciphertext, or corrupted tag.');
    this.name = 'DecryptionFailedError';
  }
}

const HKDF_SALT = Buffer.from('illumatrix-salt-v1', 'utf-8');
const HKDF_INFO = Buffer.from('illumatrix-key-storage-v1', 'utf-8');
const MASTER_KEY_FILE = path.resolve(process.cwd(), '.encryption_master_key');

/**
 * Retrieves the effective master encryption key.
 * Precedence:
 * 1. Environment variable ILLUMATRIX_ENCRYPTION_KEY / KEY_ENCRYPTION_SECRET
 * 2. Dedicated local single-tenant master key file (.encryption_master_key with 0600 permissions)
 * 3. Returns null if disabled or missing, enforcing fail-closed behavior
 */
export function getMasterKeyFromEnv(options?: { allowFileFallback?: boolean }): string | null {
  const envKey =
    process.env.ILLUMATRIX_ENCRYPTION_KEY ||
    process.env.KEY_ENCRYPTION_SECRET ||
    '';
  const clean = envKey.trim();
  if (clean.length >= 16) return clean;

  if (process.env.ILLUMATRIX_DISABLE_FILE_KEY === 'true' || options?.allowFileFallback === false) {
    return null;
  }

  // Local instance master key file fallback
  try {
    if (fs.existsSync(MASTER_KEY_FILE)) {
      const fileKey = fs.readFileSync(MASTER_KEY_FILE, 'utf-8').trim();
      if (fileKey.length >= 16) return fileKey;
    } else {
      // Generate instance-unique 256-bit cryptographic key on first initialization
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(MASTER_KEY_FILE, generated, {
        encoding: 'utf-8',
        mode: 0o600, // Process-only access permissions
      });
      return generated;
    }
  } catch {
    return null;
  }

  return null;
}

/**
 * Generates a safe, non-reversible SHA-256 credential fingerprint for cache identity.
 * Returns 'k:none' when key is absent/empty.
 * Never exposes or retains raw credentials in cache keys.
 */
export function createCredentialFingerprint(apiKey?: string): string {
  if (!apiKey || apiKey.trim().length === 0) {
    return 'k:none';
  }
  const clean = apiKey.trim();
  const digest = crypto.createHash('sha256').update(clean, 'utf-8').digest('hex');
  return `k:${digest.slice(0, 16)}`;
}

/**
 * Derives a 32-byte AES-256 key from master secret using HKDF-SHA256.
 */
export function deriveKey(masterSecret: string): Buffer {
  if (!masterSecret || masterSecret.trim().length === 0) {
    throw new MasterKeyMissingError();
  }
  return Buffer.from(
    crypto.hkdfSync('sha256', Buffer.from(masterSecret, 'utf-8'), HKDF_SALT, HKDF_INFO, 32)
  );
}

/**
 * Encrypts a plaintext secret using AES-256-GCM.
 * Fails closed if master key is not configured.
 */
export function encryptAtRest(plaintext: string, overrideMasterKey?: string): string {
  if (!plaintext || plaintext.trim().length === 0) {
    return '';
  }

  const master = overrideMasterKey !== undefined ? overrideMasterKey : getMasterKeyFromEnv();
  if (!master) {
    throw new MasterKeyMissingError(
      'Cannot persist credentials at rest: ILLUMATRIX_ENCRYPTION_KEY is not configured in environment.'
    );
  }

  const key = deriveKey(master);
  const iv = crypto.randomBytes(12); // 96-bit IV recommended for AES-GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(plaintext.trim(), 'utf-8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `enc:v1:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;
}

/**
 * Decrypts an encrypted credential string using AES-256-GCM.
 * Fails closed if master key is missing or authentication tag verification fails.
 */
export function decryptAtRest(encryptedPayload: string, overrideMasterKey?: string): string {
  if (!encryptedPayload || encryptedPayload.trim().length === 0) {
    return '';
  }

  const clean = encryptedPayload.trim();
  if (!clean.startsWith('enc:v1:')) {
    throw new DecryptionFailedError('Unrecognized encrypted payload format (expected enc:v1 prefix).');
  }

  const master = overrideMasterKey !== undefined ? overrideMasterKey : getMasterKeyFromEnv();
  if (!master) {
    throw new MasterKeyMissingError(
      'Cannot decrypt stored credentials: ILLUMATRIX_ENCRYPTION_KEY is not configured in environment.'
    );
  }

  const parts = clean.split(':');
  if (parts.length !== 5) {
    throw new DecryptionFailedError('Corrupted encrypted payload structure.');
  }

  const [, , ivBase64, tagBase64, dataBase64] = parts;

  try {
    const key = deriveKey(master);
    const iv = Buffer.from(ivBase64, 'base64');
    const tag = Buffer.from(tagBase64, 'base64');
    const ciphertext = Buffer.from(dataBase64, 'base64');

    if (iv.length !== 12 || tag.length !== 16) {
      throw new Error('Invalid IV or auth tag length.');
    }

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return decrypted.toString('utf-8');
  } catch (err: any) {
    throw new DecryptionFailedError(
      `Decryption failed: auth tag verification failed or key mismatch (${err?.message || 'crypto error'}).`
    );
  }
}

/**
 * Checks whether a given string is an enc:v1 encrypted payload.
 */
export function isEncryptedAtRest(value?: string | null): boolean {
  return typeof value === 'string' && value.trim().startsWith('enc:v1:');
}

/**
 * Comprehensive secret redaction engine for strings, logs, errors, and URLs.
 */
export function redactSecretString(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  return raw
    // Google AI Studio / Gemini keys
    .replace(/AIza[a-zA-Z0-9_\-]{20,}/gi, 'AIza***')
    .replace(/key=AIza[a-zA-Z0-9_\-]+/gi, 'key=***')
    .replace(/key=[a-zA-Z0-9_\-]{16,}/gi, 'key=***')
    // OpenRouter keys
    .replace(/sk-or-v1-[a-zA-Z0-9_\-]{16,}/gi, 'sk-or-v1-***')
    // OpenAI Project & Standard keys
    .replace(/sk-proj-[a-zA-Z0-9_\-]{16,}/gi, 'sk-proj-***')
    .replace(/sk-[a-zA-Z0-9_\-]{16,}/gi, 'sk-***')
    // Groq API keys
    .replace(/gsk_[a-zA-Z0-9_\-]{16,}/gi, 'gsk_***')
    // Cerebras keys
    .replace(/csk-[a-zA-Z0-9_\-]{16,}/gi, 'csk-***')
    // Hugging Face user tokens
    .replace(/hf_[a-zA-Z0-9_\-]{16,}/gi, 'hf_***')
    // Bearer authorization tokens
    .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, 'Bearer ***')
    // Encrypted payloads in log outputs
    .replace(/enc:v1:[a-zA-Z0-9+/=]+:[a-zA-Z0-9+/=]+:[a-zA-Z0-9+/=]+/gi, 'enc:v1:***')
    // Headers in debug dumps
    .replace(/(authorization|x-api-key|api-key|x-goog-api-key)\s*[:=]\s*["']?[^"',\s]+["']?/gi, '$1: ***')
    // SambaNova UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'uuid-***');
}

/**
 * Redacts sensitive HTTP header maps.
 */
export function redactHeaders(headers: Record<string, any> | undefined): Record<string, any> {
  if (!headers || typeof headers !== 'object') return {};
  const redacted: Record<string, any> = {};
  const sensitiveHeaders = new Set([
    'authorization',
    'x-api-key',
    'api-key',
    'x-goog-api-key',
    'proxy-authorization',
    'cookie',
    'set-cookie',
  ]);

  for (const [key, value] of Object.entries(headers)) {
    if (sensitiveHeaders.has(key.toLowerCase())) {
      redacted[key] = '***REDACTED***';
    } else if (typeof value === 'string') {
      redacted[key] = redactSecretString(value);
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}

/**
 * Deep redaction for arbitrary configuration and log objects.
 */
export function redactObject<T = any>(obj: T, seen = new WeakSet()): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return redactSecretString(obj) as any;
  }
  if (typeof obj !== 'object') {
    return obj;
  }
  if (seen.has(obj as any)) {
    return '[Circular]' as any;
  }
  seen.add(obj as any);

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item, seen)) as any;
  }

  const sensitiveFieldNames = new Set([
    'apikey',
    'api_key',
    'secret',
    'secretkey',
    'password',
    'token',
    'accesstoken',
    'access_token',
    'refreshtoken',
    'encryptedapikey',
    'encryptionkey',
    'masterkey',
  ]);

  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lowerKey = k.toLowerCase().replace(/[^a-z]/g, '');
    if (sensitiveFieldNames.has(lowerKey)) {
      result[k] = '***REDACTED***';
    } else if (typeof v === 'string') {
      result[k] = redactSecretString(v);
    } else if (typeof v === 'object' && v !== null) {
      result[k] = redactObject(v, seen);
    } else {
      result[k] = v;
    }
  }

  return result as T;
}

/**
 * Origin and Cross-Site Access Guard for Provider Credentials & Mutation API.
 * Blocks foreign website origins (e.g. from malicious sites in user's browser).
 * Allows same-origin, loopback, and trusted development / container preview domains.
 */
export function validateProviderAccessOrigin(
  req: { headers: Record<string, string | string[] | undefined> },
  res: { status: (code: number) => { json: (payload: any) => void }; statusCode?: number },
  next: () => void
): void {
  const rawOrigin = req.headers.origin;
  const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;
  if (!origin) {
    return next();
  }
  try {
    const originUrl = new URL(origin);
    const rawHost = req.headers['x-forwarded-host'] || req.headers.host || '';
    const host = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    const hostWithoutPort = String(host).split(':')[0];

    const isLocalhost =
      originUrl.hostname === 'localhost' ||
      originUrl.hostname === '127.0.0.1' ||
      originUrl.hostname === '0.0.0.0' ||
      originUrl.hostname === '::1';

    const isTrustedDomain =
      originUrl.hostname.endsWith('.run.app') ||
      originUrl.hostname.endsWith('.aistudio.google.com') ||
      originUrl.hostname.endsWith('.web.app') ||
      originUrl.hostname.endsWith('.firebaseapp.com');

    const matchesHost =
      originUrl.host === host ||
      originUrl.hostname === hostWithoutPort;

    if (isLocalhost || isTrustedDomain || matchesHost) {
      return next();
    }

    res.status(403).json({
      error: true,
      category: 'FORBIDDEN',
      message: 'Cross-origin access to provider credentials API is forbidden.',
    });
  } catch {
    res.status(403).json({
      error: true,
      category: 'FORBIDDEN',
      message: 'Invalid origin header.',
    });
  }
}

