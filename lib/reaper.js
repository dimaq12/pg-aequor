/**
 * Connection Reaper
 * Safely kills zombie connections using Advisory Locks and Signed Leases.
 */
class Reaper {
  // Namespace advisory locks to avoid collisions with other apps in same DB.
  // 0x50474151 corresponds to "PGAQ" (pg-aequor) in ASCII.
  static LOCK_NS = 0x50474151
  /**
   * Runs the reaping process.
   * @param {Object} client - The connected pg.Client
   * @param {Object} config - Config including database name
   * @param {LeaseManager} leaseManager - For verifying leases
   * @param {Object} strategy - { minConnIdleTimeSec, connUtilization }
   * @param {Function} logger
   */
  static async reap(client, config, leaseManager, strategy, logger) {
    const serviceName = leaseManager.serviceName
    let locked = false
    
    // 1. Acquire Advisory Lock (Non-blocking)
    // Use Postgres native hashtext() to get a consistent 64-bit lock ID from the service string.
    // This avoids JS-side 32-bit hash collisions.
    
    try {
      const lockRes = await client.query(
        `SELECT pg_try_advisory_lock($1::int, hashtext($2)) as locked`,
        [Reaper.LOCK_NS, serviceName]
      )
      if (lockRes.rows[0].locked !== true) {
        logger(`Reaper[pid=${process.pid}]: Lock busy, skipping`)
        return { locked: false, killed: 0 }
      }
      locked = true

      // 2. Scan for zombies
      const minIdle = strategy.minConnIdleTimeSec
      
      // Fetch idle connections that look like our service
      // Exclude self (pg_backend_pid())
      // Optimization: Filter by application_name prefix in SQL to reduce result set size.
      const query = `
        SELECT pid, application_name, extract(epoch from (now() - state_change)) as idle_time
        FROM pg_stat_activity 
        WHERE datname = current_database() 
          AND state = 'idle' 
          AND pid <> pg_backend_pid()
          AND application_name LIKE $1 || '%'
      `
      
      // Correctness > optimization: do not prefilter using untrusted application_name.
      const res = await client.query(query, [`s=${leaseManager.serviceName};`])
      const candidates = []

      for (const row of res.rows) {
        if (row.idle_time < minIdle) continue

        const lease = leaseManager.parseAndVerify(row.application_name)
        
        if (!lease) {
          // Invalid format or signature -> Unsafe to touch (could be neighbor with different secret)
          continue
        }

        if (lease.isExpired) {
          // Valid signature, but expired -> ZOMBIE
          candidates.push({
            pid: row.pid,
            idle_time: Number(row.idle_time) || 0,
            exp: lease.exp,
          })
        }
        // else: Lease valid -> ACTIVE neighbor -> Do not kill
      }

      // 3. Terminate zombies
      if (candidates.length > 0) {
        // Deterministic: kill the "stale-est" first.
        // Primary: oldest expiration (smallest exp) -> longest expired.
        // Secondary: largest idle_time.
        candidates.sort((a, b) => (a.exp - b.exp) || (b.idle_time - a.idle_time) || (a.pid - b.pid))

        const limit = Math.max(1, Number(strategy.maxIdleConnectionsToKill) || 1)
        const selected = candidates.slice(0, limit)
        const pidsToKill = selected.map(x => x.pid)

        // Log a compact reason line for debugging.
        const meta = selected.map(x => `pid=${x.pid},idle=${Math.round(x.idle_time)}s,expDelta=${Math.round((Date.now() - x.exp) / 1000)}s`).join(' | ')
        logger(`Reaper[pid=${process.pid}]: Killing ${pidsToKill.length} zombies: ${meta}`)
        // Cast to int[] to be safe
        await client.query(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE pid = ANY($1::int[])`, [pidsToKill])
        return { locked: true, killed: pidsToKill.length }
      }
      
      return { locked: true, killed: 0 }

    } catch (err) {
      logger(`Reaper[pid=${process.pid}] failed:`, err && (err.stack || err.message || err))
      if (strategy && strategy.reaperErrorMode === 'throw') throw err
      return { locked: false, killed: 0, error: err }
    } finally {
      // 4. Release Lock
      if (locked) {
        try {
          await client.query(
            `SELECT pg_advisory_unlock($1::int, hashtext($2))`,
            [Reaper.LOCK_NS, serviceName]
          )
        } catch (_) { /* ignore unlock error */ }
      }
    }
  }
  // Removed _hashString method as we use DB-side hashtext()
}

module.exports = Reaper

