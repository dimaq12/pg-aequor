/**
 * Retry Strategy & Error Classification
 * Implements "Decorrelated Jitter" and safe error analysis.
 */

class RetryStrategy {
  /**
   * Determines if an error is a "dead connection" error that warrants a retry/reconnect.
   * @param {Error} err
   * @returns {boolean}
   */
  static isRetryable(err) {
    const code = err && err.code
    const msg = (err && err.message) || ''
    const sqlstate = (err && (err.code || err.sqlstate)) || null

    // 1) Node.js socket / transport codes (not SQLSTATE)
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT' || code === 'ECONNREFUSED') return true
    if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'EAI_AGAIN') return true
    if (code === 'ECONNABORTED' || code === 'EADDRINUSE') return true

    // 2) SQLSTATE-first (stable)
    // Class 08 — connection exception
    if (typeof sqlstate === 'string' && sqlstate.length === 5 && sqlstate.startsWith('08')) return true

    // Admin / crash / cannot continue
    if (sqlstate === '57P01' || sqlstate === '57P02' || sqlstate === '57P03') return true

    // Too many connections (can be transient under spiky concurrency)
    if (sqlstate === '53300') return true

    // Optional: transient concurrency failures (only safe if queries are idempotent)
    // Keep disabled for now to avoid duplicating non-idempotent writes.
    // if (sqlstate === '40001' || sqlstate === '40P01') return true

    // 3) LAST-RESORT message fallbacks (keep minimal; remove over time)
    if (msg.includes('Connection terminated unexpectedly')) return true
    if (msg.includes('sorry, too many clients already')) return true

    return false
  }

  /**
   * Calculates backoff delay using "Decorrelated Jitter".
   * sleep = min(cap, random(base, sleep * 3))
   * @param {number} baseMs - Minimum wait
   * @param {number} capMs - Maximum wait
   * @param {number} previousDelay - The delay used in the previous attempt (or 0)
   * @returns {number} ms to sleep
   */
  static getBackoff(baseMs, capMs, previousDelay) {
    const prev = previousDelay || baseMs
    const randRange = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min
    return Math.min(capMs, randRange(baseMs, prev * 3))
  }
}

module.exports = RetryStrategy

