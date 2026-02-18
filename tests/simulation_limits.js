/**
 * Connection Limit Simulation Test (Single Process)
 * Simulates exceeding DB connection limits using multiple clients in one process.
 * This saves memory compared to forks but tests DB limits just as well.
 * 
 * Usage:
 *   DB_CONN_STRING="postgresql://user:pass@host:5432/db" node tests/simulation_limits.js
 */

const { ServerlessClient } = require('../index')

// Constants
const CLIENTS_COUNT = 150
const DB_LIMIT = 100

const dbUrl = process.env.DB_CONN_STRING
if (!dbUrl) {
  console.error('Error: DB_CONN_STRING environment variable is required.')
  process.exit(1)
}

const url = new URL(dbUrl)

async function runClient(id) {
  const client = new ServerlessClient({
    user: url.username,
    password: url.password,
    host: url.hostname,
    port: url.port,
    database: url.pathname.slice(1),
    ssl: url.hostname === 'localhost' || url.hostname === '127.0.0.1' ? false : { rejectUnauthorized: false },
    
    coordinationSecret: 'limit-test-secret',
    serviceName: 'limit-test',
    
    // Tuning
    retries: 30, // High retries
    minBackoff: 200,
    maxBackoff: 2000,
    maxConnectRetryTimeMs: 60000,
    debug: false 
  })

  // Hook logger to detect 53300
  let hitLimit = false
  client._logger = (msg, ...args) => {
    const full = String(msg) + String(args)
    if (full.includes('53300') || full.includes('too many clients')) {
        if (!hitLimit) {
            process.stdout.write('!') // Print '!' for limit hit
            hitLimit = true
        }
    }
  }

  try {
    await client.connect()
    // Hold connection
    await new Promise(r => setTimeout(r, 100)) 
    await client.clean()
    process.stdout.write('.') // Print '.' for success
    return true
  } catch (err) {
    console.error(`\n[${id}] Failed: ${err.message}`)
    return false
  }
}

(async () => {
  console.log(`[MASTER] Starting 150 clients in single process...`)
  console.log(`[MASTER] Key: '.' = Success, '!' = Hit Limit (Retrying)`)
  
  const promises = []
  for (let i = 0; i < CLIENTS_COUNT; i++) {
    promises.push(runClient(i))
    if (i % 10 === 0) await new Promise(r => setTimeout(r, 10)) // stagger slightly
  }
  
  const results = await Promise.all(promises)
  const success = results.filter(Boolean).length
  
  console.log(`\n[MASTER] Done. Success: ${success}/${CLIENTS_COUNT}`)
  
  if (success === CLIENTS_COUNT) {
      console.log('[MASTER] SUCCESS: All clients connected!')
  } else {
      console.log('[MASTER] FAILURE: Some clients failed.')
      process.exit(1)
  }
})()
