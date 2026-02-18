const crypto = require('crypto')

/**
 * Lease Manager
 * Handles generation and verification of signed application_name strings.
 * Format: "s=SERVICE;i=INSTANCE_ID;e=TIMESTAMP;g=HMAC"
 * Short keys used to fit within Postgres 63-byte limit.
 */
class LeaseManager {
  static APP_NAME_MAX_LEN = 63
  static SIG_LEN = 11 // 8 bytes -> base64url w/o padding => 11 chars

  /**
   * @param {string} serviceName - The logical name of the service
   * @param {string} instanceId - Unique ID of this client instance
   * @param {string} secret - Shared secret for HMAC (coordination secret; NOT db password)
   */
  constructor(serviceName, instanceId, secret) {
    // Keep instanceId compact and delimiter-safe.
    this.instanceId = LeaseManager._sanitizeToken(instanceId || 'inst')
    if (!secret) {
      throw new Error('LeaseManager requires a non-empty secret')
    }
    if (Buffer.byteLength(String(secret), 'utf8') < 16) {
      throw new Error('LeaseManager secret is too short; must be at least 16 bytes')
    }
    this.secret = secret
    // Normalize serviceName so application_name ALWAYS fits into 63 bytes and is LIKE-safe.
    this.serviceName = LeaseManager._normalizeServiceName(serviceName || 'sls_pg', this.instanceId)
  }

  /**
   * Generates a signed application_name.
   * @param {number} expirationTs - Unix timestamp (ms) when lease expires
   * @returns {string} The formatted application_name
   * @throws {Error} if generated name exceeds 63 bytes
   */
  generateAppName(expirationTs) {
    // Format: s=...;i=...;e=...
    const base = `s=${this.serviceName};i=${this.instanceId};e=${expirationTs}`
    const sig = this._sign(base)
    const result = `${base};g=${sig}`

    // Hard guarantee: never exceed Postgres 63-byte truncation limit.
    // If this fires, our normalization math is wrong.
    if (result.length > LeaseManager.APP_NAME_MAX_LEN) {
      throw new Error(`BUG: application_name too long (${result.length} > ${LeaseManager.APP_NAME_MAX_LEN}): ${result}`)
    }

    return result
  }

  /**
   * Parses an application_name and verifies its signature and expiration.
   * @param {string} appNameString
   * @returns {Object|null} Parsed info if valid format & signature, else null
   */
  parseAndVerify(appNameString) {
    if (!appNameString) return null

    // Regex for: s=...;i=...;e=...;g=...
    const match = appNameString.match(/^s=([^;]+);i=([^;]+);e=([^;]+);g=([^;]+)$/)
    if (!match) return null

    const [full, s, i, eStr, g] = match
    const base = `s=${s};i=${i};e=${eStr}`
    const expectedSig = this._sign(base)

    // Timing-safe signature comparison
    const bufG = Buffer.from(g, 'utf8')
    const bufExpected = Buffer.from(expectedSig, 'utf8')
    if (bufG.length !== bufExpected.length || !crypto.timingSafeEqual(bufG, bufExpected)) return null

    const exp = parseInt(eStr, 10)
    if (!Number.isFinite(exp)) return null
    
    return {
      svc: s,
      inst: i,
      exp,
      isExpired: Date.now() > exp,
      isValidSignature: true
    }
  }

  _sign(text) {
    // Compact signature: take first 8 bytes of HMAC and encode as base64url (11 chars, no padding)
    const buf = crypto.createHmac('sha256', this.secret).update(text).digest()
    return buf.subarray(0, 8).toString('base64url')
  }

  static _sanitizeToken(s) {
    // Remove delimiter characters used by our format and LIKE wildcards.
    // Keep it deterministic and log-friendly.
    return String(s).replace(/[^a-zA-Z0-9:_-]/g, '_')
  }

  static _normalizeServiceName(serviceName, instanceId) {
    const original = String(serviceName || 'sls_pg')
    const raw = LeaseManager._sanitizeToken(original)
    const inst = LeaseManager._sanitizeToken(instanceId || 'inst')

    // Total format:
    // s=<svc>;i=<inst>;e=<13digits>;g=<sig>
    // Fixed overhead excluding <svc>: "s="(2) + ";i="(3) + inst + ";e="(3) + 13 + ";g="(3) + SIG_LEN
    // => 24 + instLen + SIG_LEN
    const overhead = 24 + inst.length + LeaseManager.SIG_LEN
    const maxSvcLen = Math.max(1, LeaseManager.APP_NAME_MAX_LEN - overhead)

    // If sanitization changed the name, we must add a hash suffix to avoid accidental collisions
    // (different originals mapping to the same sanitized token).
    const needsHash = raw !== original
    if (!needsHash && raw.length <= maxSvcLen) return raw

    // Truncate with a short hash suffix to preserve uniqueness.
    const hash = crypto.createHash('sha1').update(original).digest('hex').slice(0, 8)
    if (maxSvcLen <= hash.length) return hash.slice(0, maxSvcLen)

    const prefixLen = maxSvcLen - (hash.length + 1)
    return `${raw.slice(0, prefixLen)}-${hash}`
  }
}

module.exports = LeaseManager
