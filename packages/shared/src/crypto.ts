import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDataDirs } from './paths.js'
import type { SecretSentinel } from './secrets-dto.js'

/**
 * AES-256-GCM envelope encryption for every user-supplied secret in the app:
 * LLM API keys, MCP env vars / HTTP headers, git PATs, etc.
 *
 * Envelope format: `v1.<iv>.<tag>.<ciphertext>` — all fields base64url.
 *
 * Master key lives at `<AGENT_BRIDGE_DATA_DIR>/secret.key` (32 bytes, mode 0600)
 * so the whole decryption surface is inside the same isolation boundary as the
 * ciphertexts (the DB dir, the workspace, the gitnexus-home). Override via
 * `AGENT_BRIDGE_SECRET_KEY` (base64url-encoded 32-byte key).
 *
 * This module is Node-only.
 */

const ALGO = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const ENVELOPE_PREFIX = 'v1'

const ENV_VAR = 'AGENT_BRIDGE_SECRET_KEY'

let cachedKey: Buffer | null = null

/**
 * Resolve the master key, creating it on first boot if neither the env var
 * nor the on-disk key file exist. Cached per-process.
 */
export function loadOrCreateMasterKey(): Buffer {
  if (cachedKey) return cachedKey

  const fromEnv = process.env[ENV_VAR]?.trim()
  if (fromEnv) {
    const buf = decodeBase64Url(fromEnv)
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `[crypto] ${ENV_VAR} must decode to ${KEY_BYTES} bytes, got ${buf.length}.`,
      )
    }
    cachedKey = buf
    return cachedKey
  }

  const { secretKeyPath } = ensureDataDirs()

  if (fs.existsSync(secretKeyPath)) {
    const buf = fs.readFileSync(secretKeyPath)
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `[crypto] ${secretKeyPath} is corrupt: expected ${KEY_BYTES} bytes, got ${buf.length}. ` +
          `Restore from backup or delete to regenerate (will invalidate every existing ciphertext).`,
      )
    }
    cachedKey = buf
    return cachedKey
  }

  const generated = crypto.randomBytes(KEY_BYTES)
  fs.writeFileSync(secretKeyPath, generated, { mode: 0o600 })
  try {
    fs.chmodSync(secretKeyPath, 0o600)
  } catch {
    // chmod may fail on some platforms; writeFileSync already set the mode.
  }

  console.warn(
    `[crypto] Generated new data-encryption key at ${secretKeyPath}. ` +
      `Back it up if you want to restore your encrypted secrets across machines. ` +
      `Losing the key means every encrypted value becomes unrecoverable.`,
  )

  cachedKey = generated
  return cachedKey
}

/** Encrypt a plaintext secret. Returns an opaque envelope string safe to store in DB. */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string') {
    throw new TypeError('[crypto] plaintext must be a string')
  }
  const key = loadOrCreateMasterKey()
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ])
  const tag = cipher.getAuthTag()
  return [
    ENVELOPE_PREFIX,
    encodeBase64Url(iv),
    encodeBase64Url(tag),
    encodeBase64Url(ciphertext),
  ].join('.')
}

/** Decrypt an envelope back to plaintext. Throws on tamper / wrong key. */
export function decryptSecret(envelope: string): string {
  if (!isEncryptedEnvelope(envelope)) {
    throw new Error('[crypto] not a valid envelope')
  }
  const parts = envelope.split('.')
  const [, ivB64, tagB64, ctB64] = parts as [string, string, string, string]
  const iv = decodeBase64Url(ivB64)
  const tag = decodeBase64Url(tagB64)
  const ciphertext = decodeBase64Url(ctB64)
  if (iv.length !== IV_BYTES) {
    throw new Error(`[crypto] bad iv length: ${iv.length}`)
  }
  if (tag.length !== TAG_BYTES) {
    throw new Error(`[crypto] bad tag length: ${tag.length}`)
  }
  const key = loadOrCreateMasterKey()
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ])
  return plaintext.toString('utf8')
}

/** Cheap structural check — use at DB read boundaries to spot unencrypted values. */
export function isEncryptedEnvelope(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const parts = value.split('.')
  if (parts.length !== 4) return false
  return parts[0] === ENVELOPE_PREFIX && parts.slice(1).every(Boolean)
}

export function describeSecret(
  envelope: string | null | undefined,
): SecretSentinel {
  if (!envelope || !isEncryptedEnvelope(envelope)) {
    return { set: false, length: 0 }
  }
  try {
    const plaintext = decryptSecret(envelope)
    return { set: true, length: plaintext.length }
  } catch {
    return { set: false, length: 0 }
  }
}

/** Test-only — forgets the cached key so `loadOrCreateMasterKey()` re-reads. */
export function __resetCryptoCacheForTest(): void {
  cachedKey = null
}

function encodeBase64Url(buf: Buffer): string {
  return buf.toString('base64url')
}
function decodeBase64Url(s: string): Buffer {
  return Buffer.from(s, 'base64url')
}

/**
 * Resolve the ambient data-dir's secret key path without touching the file.
 * Useful for telemetry / health-check code that wants to show the path.
 */
export function getSecretKeyPath(): string {
  const { secretKeyPath } = ensureDataDirs()
  return path.normalize(secretKeyPath)
}
