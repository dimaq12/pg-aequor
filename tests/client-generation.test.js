const { test, describe } = require('node:test')
const assert = require('node:assert')

const ServerlessClient = require('../lib/client')

class FakePgClient {
  constructor() {
    this.handlers = {}
    this._connectResolve = null
    this._connectPromise = new Promise((res) => { this._connectResolve = res })
    this.ended = false
  }
  on(ev, fn) {
    this.handlers[ev] = this.handlers[ev] || []
    this.handlers[ev].push(fn)
  }
  emit(ev, arg) {
    for (const fn of this.handlers[ev] || []) fn(arg)
  }
  async connect() {
    return this._connectPromise
  }
  async end() {
    this.ended = true
  }
  async query() {
    return { rows: [] }
  }
}

function makeFakePgLibrary() {
  const instances = []
  class Client {
    constructor() {
      const c = new FakePgClient()
      instances.push(c)
      return c
    }
  }
  return { Client, instances }
}

describe('ServerlessClient generation guard', () => {
  test('stale connect cannot resurrect disposed client', async () => {
    const lib = makeFakePgLibrary()
    const c = new ServerlessClient({
      host: 'x',
      user: 'u',
      password: 'p',
      database: 'd',
      coordinationSecret: 'coord-secret-123456',
      library: lib,
      reaper: false,
      leaseTtlMs: 1000,
    })

    // Start connect, but do not resolve it yet
    const p = c.connect()
    // Let the connect coroutine construct the underlying client.
    await new Promise((res) => setImmediate(res))
    assert.ok(lib.instances.length === 1)
    const inner = lib.instances[0]

    // While connect is in-flight, trigger an error which should mark dead + dispose
    inner.emit('error', Object.assign(new Error('boom'), { code: 'ECONNRESET' }))

    // Now resolve the original connect
    inner._connectResolve()
    await p

    // Generation guard should prevent resurrecting this client
    assert.notStrictEqual(c._client, inner)
  })
})


