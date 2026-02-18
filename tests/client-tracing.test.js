const { test, describe } = require('node:test')
const assert = require('node:assert')

const ServerlessClient = require('../lib/client')

class FakePgClient {
  constructor() {
    this.handlers = {}
    this.connected = false
    this.ended = false
    this.failQuery = false
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
    if (this.failQuery) throw new Error('query-failed')
    return { rows: [], rowCount: 0 }
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

describe('ServerlessClient tracing hooks', () => {
  test('onQueryStart/End hooks fire on successful query', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      hooks: {
        onQueryStart: (p) => calls.push(['onQueryStart', p]),
        onQueryEnd: (p) => calls.push(['onQueryEnd', p]),
      },
    })

    await c.connect()
    const args = ['SELECT 1', []]
    await c.query(...args)

    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0][0], 'onQueryStart')
    assert.deepStrictEqual(calls[0][1].args, args)
    assert.strictEqual(typeof calls[0][1].startedAt, 'number')

    assert.strictEqual(calls[1][0], 'onQueryEnd')
    assert.deepStrictEqual(calls[1][1].args, args)
    assert.ok(calls[1][1].duration >= 0)
  })

  test('onQueryError hook fires on query failure', async () => {
    const lib = makeFakePgLibrary()
    const calls = []
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      retries: 0, // fail fast
      hooks: {
        onQueryStart: (p) => calls.push(['onQueryStart', p]),
        onQueryError: (p) => calls.push(['onQueryError', p]),
      },
    })

    await c.connect()
    lib.instances[0].failQuery = true

    await assert.rejects(() => c.query('SELECT 1'))

    assert.strictEqual(calls.length, 2)
    assert.strictEqual(calls[0][0], 'onQueryStart')
    assert.strictEqual(calls[1][0], 'onQueryError')
    assert.strictEqual(calls[1][1].err.message, 'query-failed')
    assert.ok(calls[1][1].duration >= 0)
  })
})

