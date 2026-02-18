/**
 * Isolation Simulation Test
 * Verifies that the Reaper respects service boundaries and signature validity.
 * 
 * Usage:
 *   DB_CONN_STRING="postgresql://user:pass@host:5432/db" node tests/simulation_isolation.js
 */

const { fork } = require('child_process')

// Constants
const TARGET_ZOMBIES = 10
const NEIGHBOR_ZOMBIES = 10
const IMPOSTOR_ZOMBIES = 5
const LEASE_TTL_MS = 2000
const IDLE_TIME_SEC = 1
const REAPER_COOLDOWN_MS = 1000

const dbUrl = process.env.DB_CONN_STRING
if (!dbUrl) {
  console.error('Error: DB_CONN_STRING environment variable is required.')
  process.exit(1)
}

function spawnWorker(id, type, config) {
  return fork(__filename, ['worker'], {
    env: {
      ...process.env,
      WORKER_ID: id,
      WORKER_TYPE: type,
      WORKER_CONFIG: JSON.stringify(config),
      LEASE_TTL_MS,
      IDLE_TIME_SEC,
      REAPER_COOLDOWN_MS
    }
  })
}

// --- MASTER PROCESS ---
if (process.argv[2] !== 'worker') {
  (async () => {
    console.log('[MASTER] Starting Isolation Simulation...')
    
    const processes = []
    
    // 1. Spawn TARGET Zombies (service='target', secret='secret-A')
    // These SHOULD be killed by Reaper A.
    console.log('[MASTER] Spawning 10 TARGET zombies (should die)...')
    for (let i = 0; i < TARGET_ZOMBIES; i++) {
      processes.push(spawnWorker(`target-${i}`, 'zombie', { 
        serviceName: 'target-service', 
        secret: 'secret-AAAAAAAAAAAAAAAA' 
      }))
    }

    // 2. Spawn NEIGHBOR Zombies (service='neighbor', secret='secret-B')
    // These SHOULD NOT be touched by Reaper A.
    console.log('[MASTER] Spawning 10 NEIGHBOR zombies (should survive Reaper A)...')
    for (let i = 0; i < NEIGHBOR_ZOMBIES; i++) {
      processes.push(spawnWorker(`neighbor-${i}`, 'zombie', { 
        serviceName: 'neighbor-service', 
        secret: 'secret-BBBBBBBBBBBBBBBB' 
      }))
    }

    // 3. Spawn IMPOSTOR Zombies (service='target', secret='secret-FAKE')
    // These have the SAME service name but WRONG signature.
    // These SHOULD NOT be touched by Reaper A (invalid signature).
    console.log('[MASTER] Spawning 5 IMPOSTOR zombies (should survive due to bad signature)...')
    for (let i = 0; i < IMPOSTOR_ZOMBIES; i++) {
      processes.push(spawnWorker(`impostor-${i}`, 'zombie', { 
        serviceName: 'target-service', 
        secret: 'secret-FAKE-Key-Must-Be-16' 
      }))
    }
    
    // Wait for zombies to connect and go idle
    await new Promise(r => setTimeout(r, LEASE_TTL_MS + 2000))

    // 4. Run Reaper A (service='target', secret='secret-A')
    console.log('[MASTER] Unleashing Reaper A (target-service)...')
    const reaperA = spawnWorker('reaper-A', 'reaper', { 
        serviceName: 'target-service', 
        secret: 'secret-AAAAAAAAAAAAAAAA' 
    })
    
    // Wait for Reaper A to do its job
    await new Promise(r => setTimeout(r, 5000))
    reaperA.kill()

    console.log('[MASTER] Simulation complete. Cleaning up...')
    processes.forEach(p => p.kill())
    
    console.log('[MASTER] Check logs above.')
    console.log('[MASTER] EXPECTATION:')
    console.log('  - TARGET zombies: Killed (57P01)')
    console.log('  - NEIGHBOR zombies: Alive (No error)')
    console.log('  - IMPOSTOR zombies: Alive (No error)')
  })()
} 

// --- WORKER PROCESS ---
else {
  const { ServerlessClient } = require('../index')
  
  const id = process.env.WORKER_ID
  const type = process.env.WORKER_TYPE
  const config = JSON.parse(process.env.WORKER_CONFIG)
  
  const url = new URL(process.env.DB_CONN_STRING)
  
  const client = new ServerlessClient({
    user: url.username,
    password: url.password,
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1),
    ssl: url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false },
    
    secret: config.secret,
    serviceName: config.serviceName,
    
    leaseTtlMs: Number(process.env.LEASE_TTL_MS),
    minConnectionIdleTimeSec: Number(process.env.IDLE_TIME_SEC),
    reaperCooldownMs: 100, // Fast reaper for test
    maxIdleConnectionsToKill: 50,
    debug: type === 'reaper' // Only reaper logs debug info
  })

  // Override logger for zombies to capture errors
  if (type === 'zombie') {
    client._logger = (msg, err) => {
      if (err && String(err).includes('57P01')) {
        console.log(`[${id}] KILLED (Correctly)`)
      }
    }
  } else {
    client._logger = (...args) => console.log(`[${id}]`, ...args)
  }

  ;(async () => {
    try {
      await client.connect()
      
      if (type === 'zombie') {
        // Just hang
        setInterval(async () => {
            // Check if still connected
            try {
                // If client is dead, this throws/reconnects. 
                // We want to detect if we were killed.
                // The _logger hook above catches 57P01.
            } catch (e) {}
        }, 1000)
      } else if (type === 'reaper') {
        console.log(`[${id}] Reaper started. Scanning...`)
        // The reaper logic runs automatically on connect (with probability check removed in latest version)
        // We wait a bit to let it finish
        setTimeout(async () => {
            console.log(`[${id}] Reaper done.`)
            await client.clean()
            process.exit(0)
        }, 3000)
      }
    } catch (err) {
      console.error(`[${id}] Error:`, err.message)
      process.exit(1)
    }
  })()
}

