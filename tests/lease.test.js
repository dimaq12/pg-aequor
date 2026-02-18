const { test, describe } = require('node:test')
const assert = require('node:assert')
const LeaseManager = require('../lib/lease')

describe('LeaseManager', () => {
  const secret = 'test-secret-123456'
  const lease = new LeaseManager('test-svc', 'inst-1', secret)

  test('should generate valid signed string', () => {
    const exp = Date.now() + 1000
    const appName = lease.generateAppName(exp)
    
    // Updated short keys: s=, i=, e=, g=
    assert.match(appName, /s=test-svc/)
    assert.match(appName, /i=inst-1/)
    // base64url signature (8 bytes => 11 chars, no padding)
    assert.match(appName, /g=[A-Za-z0-9_-]{11}/)
    assert.ok(appName.length <= 63, 'AppName must fit in 63 bytes')
  })

  test('should verify valid lease', () => {
    const exp = Date.now() + 10000
    const appName = lease.generateAppName(exp)
    const result = lease.parseAndVerify(appName)

    assert.ok(result)
    assert.strictEqual(result.svc, 'test-svc')
    assert.strictEqual(result.inst, 'inst-1')
    assert.strictEqual(result.isExpired, false)
  })

  test('should reject invalid signature', () => {
    const exp = Date.now() + 10000
    const real = lease.generateAppName(exp)
    // Tamper with the string (change instance ID but keep signature)
    const fake = real.replace('i=inst-1', 'i=hacker')
    
    const result = lease.parseAndVerify(fake)
    assert.strictEqual(result, null)
  })

  test('should detect expired lease', () => {
    const exp = Date.now() - 1000 // In the past
    const appName = lease.generateAppName(exp)
    const result = lease.parseAndVerify(appName)

    assert.ok(result) // Signature is valid...
    assert.strictEqual(result.isExpired, true) // ...but it is expired
  })

  test('should normalize too long service names (never exceed 63 bytes)', () => {
    const longSvc = 'a'.repeat(200)
    const leaseLong = new LeaseManager(longSvc, 'inst-1', secret)
    const appName = leaseLong.generateAppName(Date.now() + 1000)
    assert.ok(appName.length <= 63)
    const parsed = leaseLong.parseAndVerify(appName)
    assert.ok(parsed)
    assert.strictEqual(parsed.inst, 'inst-1')
  })

  test('should require a secret', () => {
    assert.throws(() => new LeaseManager('svc', 'inst', ''), /requires a non-empty secret/)
    assert.throws(() => new LeaseManager('svc', 'inst', null), /requires a non-empty secret/)
    assert.throws(() => new LeaseManager('svc', 'inst', 'short'), /too short/)
  })
})
