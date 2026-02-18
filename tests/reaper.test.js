const { test, describe, beforeEach } = require('node:test')
const assert = require('node:assert')
const Reaper = require('../lib/reaper')
const LeaseManager = require('../lib/lease')

describe('Reaper', () => {
  const secret = 'secret-1234567890'
  const leaseManager = new LeaseManager('mysvc', 'inst-1', secret)
  const config = { database: 'mydb' }
  const strategy = { minConnIdleTimeSec: 10, connUtilization: 0.8, maxIdleConnectionsToKill: 1 }
  const logger = () => {}

  test('should acquire lock, scan, and release', async () => {
    let queries = []
    const mockClient = {
      query: async (text, params) => {
        queries.push({ text, params })
        
        // Mock Lock: Acquired
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] }
        
        // Mock Scan: Return two zombies (expired) and one active (valid)
        if (text.includes('pg_stat_activity')) {
          const expired1 = leaseManager.generateAppName(Date.now() - 5000)
          const expired2 = leaseManager.generateAppName(Date.now() - 6000)
          const active = leaseManager.generateAppName(Date.now() + 5000)
          return {
            rows: [
              { pid: 100, application_name: expired1, idle_time: 20 },
              { pid: 150, application_name: expired2, idle_time: 25 },
              { pid: 200, application_name: active, idle_time: 20 }
            ]
          }
        }

        // Mock Kill
        if (text.includes('pg_terminate_backend')) {
          return { rowCount: 1 } // Killed 1
        }

        return { rows: [] }
      }
    }

    const result = await Reaper.reap(mockClient, config, leaseManager, strategy, logger)

    assert.strictEqual(result.killed, 1) // maxIdleConnectionsToKill=1 => kill only one zombie
    assert.strictEqual(result.locked, true)
    
    // Check if Kill query contained exactly one PID, and not the active one
    const killQuery = queries.find(q => q.text.includes('pg_terminate_backend'))
    assert.ok(killQuery)
    assert.strictEqual(Array.isArray(killQuery.params[0]), true)
    assert.strictEqual(killQuery.params[0].length, 1)
    assert.notStrictEqual(killQuery.params[0][0], 200)
    
    // Check Unlock
    const unlockQuery = queries.find(q => q.text.includes('pg_advisory_unlock'))
    assert.ok(unlockQuery)
  })

  test('should skip if lock is busy', async () => {
    const mockClient = {
      query: async (text) => {
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] }
        throw new Error('Should not reach here')
      }
    }
    const result = await Reaper.reap(mockClient, config, leaseManager, strategy, logger)
    assert.strictEqual(result.killed, 0)
    assert.strictEqual(result.locked, false)
  })

  test('should not unlock if lock not acquired', async () => {
    const calls = []
    const mockClient = {
      query: async (text, params) => {
        calls.push({ text, params })
        if (text.includes('pg_try_advisory_lock')) return { rows: [{ locked: false }] }
        return { rows: [] }
      }
    }
    const result = await Reaper.reap(mockClient, config, leaseManager, strategy, logger)
    assert.strictEqual(result.killed, 0)
    assert.strictEqual(result.locked, false)
    const unlockCall = calls.find(c => c.text.includes('pg_advisory_unlock'))
    assert.strictEqual(Boolean(unlockCall), false)
  })
})

