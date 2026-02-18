/**
 * Load Test Simulation for Reaper
 * Simulates a "Zombie Storm" and verifies that a new wave of connections cleans up the old ones.
 * 
 * Usage:
 *   DB_CONN_STRING="postgresql://user:pass@host:5432/db" node tests/simulation.js
 */

const { fork } = require('child_process')
const path = require('path')

// Constants
const ZOMBIES_COUNT = 20
const STORM_COUNT = 20
const LEASE_TTL_MS = 2000
const IDLE_TIME_SEC = 1 // Min idle time to be considered a zombie
const REAPER_COOLDOWN_MS = 1000

const dbUrl = process.env.DB_CONN_STRING
if (!dbUrl) {
  console.error('Error: DB_CONN_STRING environment variable is required.')
  process.exit(1)
}

// Helper to spawn a worker process
function spawnWorker(id, type) {
  return fork(__filename, ['worker'], {
    env: {
      ...process.env,
      WORKER_ID: id,
      WORKER_TYPE: type,
      LEASE_TTL_MS,
      IDLE_TIME_SEC,
      REAPER_COOLDOWN_MS
    }
  })
}

// --- MASTER PROCESS ---
if (process.argv[2] !== 'worker') {
  (async () => {
    console.log(`[MASTER] Starting simulation with ${ZOMBIES_COUNT} zombies and ${STORM_COUNT} stormers...`)
    
    const zombies = []
    
    // 1. Spawn Zombies
    console.log('[MASTER] Phase 1: Spawning Zombies...')
    for (let i = 0; i < ZOMBIES_COUNT; i++) {
      const z = spawnWorker(`zombie-${i}`, 'zombie')
      zombies.push(z)
      // Stagger slightly to avoid DB connection limit instantly
      await new Promise(r => setTimeout(r, 50)) 
    }
    
    // Wait for zombies to connect and query
    console.log('[MASTER] Phase 1: Zombies active. Waiting for lease expiration...')
    await new Promise(r => setTimeout(r, LEASE_TTL_MS + 1500)) // Wait > TTL + Idle Time

    // 2. Spawn Storm (Active Clients)
    console.log('[MASTER] Phase 2: Unleashing the Storm (Active Clients)...')
    const stormers = []
    for (let i = 0; i < STORM_COUNT; i++) {
      const s = spawnWorker(`storm-${i}`, 'storm')
      stormers.push(s)
    }

    // Wait for storm to process
    await new Promise(r => setTimeout(r, 5000))

    // 3. Cleanup
    console.log('[MASTER] Simulation complete. Cleaning up processes...')
    zombies.forEach(p => p.kill())
    stormers.forEach(p => p.kill())
    
    console.log('[MASTER] Check your DB logs or output above for "Reaper: Killed" messages.')
  })()
} 

// --- WORKER PROCESS ---
else {
  const { ServerlessClient } = require('../index')
  
  const type = process.env.WORKER_TYPE
  const id = process.env.WORKER_ID
  
  // Parse DB URL
  const url = new URL(process.env.DB_CONN_STRING)
  
  const client = new ServerlessClient({
    user: url.username,
    password: url.password,
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1),
    ssl: url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false }, // No SSL for local docker
    
    // Coordination Config
    secret: 'test-secret-must-be-long-enough-16B',
    serviceName: 'load-test',
    
    // Test Tunings
    leaseTtlMs: Number(process.env.LEASE_TTL_MS),
    minConnectionIdleTimeSec: Number(process.env.IDLE_TIME_SEC),
    reaperCooldownMs: Number(process.env.REAPER_COOLDOWN_MS),
    reaperRunProbability: 1.0, // Force try (subject to cooldown/lock)
    maxIdleConnectionsToKill: 50, // Kill many
    
    debug: true // Enable logging to see Reaper actions
  })

  // Override logger to prefix with ID
  client._logger = (...args) => console.log(`[${id}]`, ...args)

  ;(async () => {
    try {
      await client.connect()
      await client.query('SELECT pg_sleep(0.1)') // Simulate some work
      
      if (type === 'zombie') {
        console.log(`[${id}] I am a zombie. Sleeping (simulating freeze)...`)
        // Simulate Freeze: Wait longer than lease & storm delay
        // Storm starts at 3.5s (2s wait + 1.5s). We wake up at 6s.
        await new Promise(r => setTimeout(r, 6000)) 
        
        console.log(`[${id}] I woke up! My connection should be dead. Trying to query (Resurrection)...`)
        try {
            await client.query('SELECT 1')
            console.log(`[${id}] Resurrection SUCCESS! Client reconnected and query worked.`)
            await client.clean()
        } catch (e) {
            console.error(`[${id}] Resurrection FAILED:`, e.message)
            process.exit(1)
        }
      } else {
        console.log(`[${id}] I am active. Querying...`)
        await client.query('SELECT 1')
        // Stormers stay active for a bit to allow Reaper to run
        setTimeout(async () => {
            console.log(`[${id}] Done.`)
            await client.clean()
            process.exit(0)
        }, 4000)
      }
    } catch (err) {
      console.error(`[${id}] Error:`, err.message)
      process.exit(1)
    }
  })()
}

