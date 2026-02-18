const { test, describe } = require('node:test')
const assert = require('node:assert')

const ServerlessClient = require('../lib/client')

class FakePgClient {
  constructor() {
    this.connected = false
    this.ended = false
    this.handlers = {}
    this.failSetConfig = false
    this.hangSetConfig = false
  }
  on(ev, fn) {
    this.handlers[ev] = this.handlers[ev] || []
    this.handlers[ev].push(fn)
  }
  emit(ev, arg) {
    for (const fn of this.handlers[ev] || []) fn(arg)
  }
  async connect() {
    this.connected = true
  }
  async end() {
    this.ended = true
    this.connected = false
  }
  async query(sql, params) {
    if (String(sql).includes("set_config('application_name'")) {
      if (this.hangSetConfig) return new Promise(() => {})
      if (this.failSetConfig) throw Object.assign(new Error('boom'), { code: 'ECONNRESET' })
      return { rows: [{ set_config: params && params[0] }] }
    }
    return { rows: [] }
  }
}

function makeFakePgLibrary() {
  const instances = []
  class Client {
    constructor(_cfg) {
      const inner = new FakePgClient()
      instances.push(inner)
      return inner
    }
  }
  return { Client, instances }
}

describe('ServerlessClient heartbeat', () => {
  test('hard-wait heartbeat failure triggers reconnect by default', async () => {
    const lib = makeFakePgLibrary()

    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      secret: 'coord-secret-123456',
      database: 'd',
      library: lib,
      // make lease almost expired so hard-wait path runs
      leaseTtlMs: 10,
      heartbeatSoftRemainingMs: 1000,
      heartbeatHardWaitRemainingMs: 1000,
      reaper: false,
    })

    await c.connect()
    assert.ok(lib.instances.length >= 1)
    const inner = lib.instances[0]
    // force heartbeat failure
    inner.failSetConfig = true
    // make lease expired
    c._leaseExp = Date.now() - 1

    // heartbeat hard-wait path runs; default heartbeatErrorMode is 'reconnect'
    // so it should NOT throw, but it SHOULD dispose the client.
    await c._heartbeatIfNeeded()

    assert.strictEqual(c._client, null)
    assert.strictEqual(c._isDead, true)
  })

  test('heartbeat timeout triggers reconnect by default', async () => {
    const lib = makeFakePgLibrary()

    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      secret: 'coord-secret-123456',
      database: 'd',
      library: lib,
      leaseTtlMs: 10,
      heartbeatSoftRemainingMs: 1000,
      heartbeatHardWaitRemainingMs: 1000,
      heartbeatTimeoutMs: 5,
      reaper: false,
    })

    await c.connect()
    const inner = lib.instances[0]
    inner.hangSetConfig = true
    c._leaseExp = Date.now() - 1

    await c._heartbeatIfNeeded()
    assert.strictEqual(c._client, null)
    assert.strictEqual(c._isDead, true)
  })

  test('optional lease mode without secret disables lease/reaper/heartbeat but still connects', async () => {
    const lib = makeFakePgLibrary()
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      database: 'd',
      library: lib,
      leaseMode: 'optional',
      reaper: true, // should be disabled due to no secret
    })
    await c.connect()
    assert.ok(c._client) // connected
    assert.strictEqual(c._leaseManager, null)
  })
})


