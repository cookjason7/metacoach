import crypto from 'crypto'

/**
 * Application-layer encryption for Google Health OAuth tokens at rest.
 *
 * Tokens (access_token / refresh_token) live in the fitbit_tokens table as
 * plain TEXT columns. To satisfy CASA Tier 2 (encryption of OAuth credentials
 * at rest), every value written to those columns is encrypted here and every
 * value read back is decrypted here — the column type stays TEXT and simply
 * holds a base64-encoded envelope instead of the raw token.
 *
 * Envelope format (all three parts base64, joined by ':'):
 *   iv:authTag:ciphertext
 *
 * Cipher: AES-256-GCM. Key is derived from GOOGLE_HEALTH_TOKEN_SECRET via
 * scrypt with a fixed salt. No external dependencies — Node's crypto only.
 *
 * NEVER log a plaintext or ciphertext token value from this module.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_LENGTH = 32          // 256-bit key
const IV_LENGTH = 12           // 96-bit nonce, recommended for GCM
const KEY_SALT = 'lwc-token-salt'

// Key derivation is lazy (not at import time) so the server can boot before
// GOOGLE_HEALTH_TOKEN_SECRET is configured — only Google Health token
// operations fail until the secret is set, rather than the whole process.
let cachedKey = null

function getKey() {
  if (cachedKey) return cachedKey
  const secret = process.env.GOOGLE_HEALTH_TOKEN_SECRET
  if (!secret) {
    throw new Error('GOOGLE_HEALTH_TOKEN_SECRET environment variable is required')
  }
  cachedKey = crypto.scryptSync(secret, KEY_SALT, KEY_LENGTH)
  return cachedKey
}

/**
 * Encrypt a plaintext token string with AES-256-GCM.
 * @param {string} plaintext
 * @returns {string} base64 envelope "iv:authTag:ciphertext"
 */
export function encryptToken(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('encryptToken requires a non-empty string')
  }
  const key = getKey()
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return [
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':')
}

/**
 * Decrypt a token envelope produced by encryptToken().
 * @param {string} encrypted  base64 envelope "iv:authTag:ciphertext"
 * @returns {string} plaintext token
 */
export function decryptToken(encrypted) {
  if (typeof encrypted !== 'string') {
    throw new Error('decryptToken requires a string')
  }
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format')
  }
  const [ivB64, authTagB64, ciphertextB64] = parts
  const key = getKey()
  const iv = Buffer.from(ivB64, 'base64')
  const authTag = Buffer.from(authTagB64, 'base64')
  const ciphertext = Buffer.from(ciphertextB64, 'base64')
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

/**
 * Best-effort check that a stored value is already in encrypted-envelope form.
 * Used by the one-time migration to stay idempotent. Google OAuth tokens never
 * contain ':' , so a 3-part colon-split that also decrypts cleanly is a
 * reliable "already encrypted" signal.
 * @param {string} value
 * @returns {boolean}
 */
export function isEncryptedToken(value) {
  if (typeof value !== 'string') return false
  if (value.split(':').length !== 3) return false
  try {
    decryptToken(value)
    return true
  } catch {
    return false
  }
}
