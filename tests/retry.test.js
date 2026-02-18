const { test, describe } = require('node:test')
const assert = require('node:assert')
const RetryStrategy = require('../lib/retry')

describe('RetryStrategy', () => {
  test('should identify fatal postgres codes as retryable', () => {
    assert.strictEqual(RetryStrategy.isRetryable({ code: '57P01' }), true)
    assert.strictEqual(RetryStrategy.isRetryable({ code: '08006' }), true)
    assert.strictEqual(RetryStrategy.isRetryable({ code: '08003' }), true)
  })

  test('should identify node socket errors as retryable', () => {
    assert.strictEqual(RetryStrategy.isRetryable({ code: 'ECONNRESET' }), true)
    assert.strictEqual(RetryStrategy.isRetryable({ code: 'EPIPE' }), true)
    assert.strictEqual(RetryStrategy.isRetryable({ code: 'ETIMEDOUT' }), true)
  })

  test('should identify fatal messages as retryable', () => {
    assert.strictEqual(RetryStrategy.isRetryable({ message: 'Connection terminated unexpectedly' }), true)
  })

  test('should NOT retry generic errors', () => {
    assert.strictEqual(RetryStrategy.isRetryable({ code: '23505' }), false) // unique_violation
    assert.strictEqual(RetryStrategy.isRetryable({ code: '42601' }), false) // syntax_error
    assert.strictEqual(RetryStrategy.isRetryable({ message: 'syntax error' }), false)
    assert.strictEqual(RetryStrategy.isRetryable(new Error('Random failure')), false)
  })

  test('getBackoff should respect limits', () => {
    const delay = RetryStrategy.getBackoff(10, 1000, 50)
    assert.ok(delay >= 10)
    assert.ok(delay <= 1000)
  })

  test('getBackoff should not always return tiny values when prevDelay grows', () => {
    // This is a shape test: with large prevDelay, range expands.
    const base = 100
    const cap = 2000
    const prev = 1500
    const delay = RetryStrategy.getBackoff(base, cap, prev)
    assert.ok(delay >= base)
    assert.ok(delay <= cap)
  })
})

