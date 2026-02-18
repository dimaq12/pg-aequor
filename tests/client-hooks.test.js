const { test, describe } = require('node:test')
const assert = require('node:assert')

const ServerlessClient = require('../lib/client')

class FakePgClient {
  constructor() {
    this.handlers = {}
    this.connected = false
    this.ended = false
    this.failUserQueryOnce = false
    this.failHeartbeat = false
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
    const s = String(sql)
    if (s.includes("set_config('application_name'")) {
      if (this.failHeartbeat) throw Object.assign(new Error('hb-fail'), { code: 'ECONNRESET' })
      return { rows: [{ set_config: params && params[0] }] }
    }
    // Simulate a transient socket error on the first user query.
    if (this.failUserQueryOnce) {
      this.failUserQueryOnce = false
      throw Object.assign(new Error('q-fail'), { code: 'ECONNRESET' })
    }
    return { rows: [] }
  }
}

function makeFakePgLibrary() {
  const instances = []
  class Client {
    constructor(_cfg) {
      const c = new FakePgClient()
      instances.push(c)
      return c
    }
  }
  return { Client, instances }
}

describe('ServerlessClient hooks', () => {
  test('onConnect is called on successful connect', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      hooks: {
        onConnect: (p) => calls.push(['onConnect', p]),
      },
    })

    await c.connect()
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0][0], 'onConnect')
  })

  test('onHeartbeat and onHeartbeatFail fire appropriately', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      leaseTtlMs: 10,
      heartbeatSoftRemainingMs: 1000,
      heartbeatHardWaitRemainingMs: 1000,
      heartbeatTimeoutMs: 50,
      hooks: {
        onHeartbeat: (p) => calls.push(['onHeartbeat', p]),
        onHeartbeatFail: (p) => calls.push(['onHeartbeatFail', p]),
      },
    })

    await c.connect()
    const inner = lib.instances[0]

    // Success path
    c._leaseExp = Date.now() - 1
    await c._heartbeatIfNeeded()
    assert.ok(calls.some((x) => x[0] === 'onHeartbeat'))

    // Failure path
    inner.failHeartbeat = true
    c._leaseExp = Date.now() - 1
    await c._heartbeatIfNeeded()
    assert.ok(calls.some((x) => x[0] === 'onHeartbeatFail'))
  })

  test('onClientDead is called when pg emits error', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      hooks: {
        onClientDead: (p) => calls.push(['onClientDead', p]),
      },
    })

    await c.connect()
    const inner = lib.instances[0]
    inner.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }))

    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0][0], 'onClientDead')
    assert.strictEqual(c._isDead, true)
  })

  test('onQueryRetry is called on retryable query error', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      retries: 1,
      minBackoff: 1,
      maxBackoff: 1,
      maxQueryRetryTimeMs: 5000,
      hooks: {
        onQueryRetry: (p) => calls.push(['onQueryRetry', p]),
      },
    })

    await c.connect()
    // Force first user query to fail with a retryable socket error
    lib.instances[0].failUserQueryOnce = true

    await c.query('SELECT 1')
    assert.ok(calls.length >= 1)
    assert.strictEqual(calls[0][0], 'onQueryRetry')
    assert.strictEqual(calls[0][1].retries, 1)
  })
})


