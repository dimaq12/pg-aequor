const RetryStrategy = require('./retry')
const LeaseManager = require('./lease')
const Reaper = require('./reaper')
const crypto = require('crypto')

class AequorClient {
  constructor(config = {}) {
    this._config = config
    this._library = config.library || require('pg')
    this._client = null
    this._isDead = false // Flag to force recreation
    this._generation = 0
    this._connectPromise = null
    
    // Retry Strategy
    this._retryStrategy = {
      retries: config.retries ?? 3,
      minBackoff: config.minBackoff ?? 100, // ms
      maxBackoff: config.maxBackoff ?? 2000 // ms
    }

    // Lease/Reaper mode:
    // - required: coordinationSecret must be provided (safe distributed coordination)
    // - optional: if coordinationSecret missing, disable lease/reaper/heartbeat but client still works
    this._leaseMode = config.leaseMode || 'required' // 'required' | 'optional'

    // Reaper config (can be disabled if lease is disabled)
    this._reaperEnabled = config.reaper !== false
    this._strategy = {
      // Probability of running a reaper pass on connect (0..1). Alias for backwards compatibility.
      reaperRunProbability: config.reaperRunProbability ?? config.connUtilization ?? 0.1,
      // Default should be minutes, not seconds, otherwise you create your own outages.
      minConnIdleTimeSec: config.minConnectionIdleTimeSec || 180, // Default 3m
      maxIdleConnectionsToKill: config.maxIdleConnectionsToKill || 10,
      reaperErrorMode: config.reaperErrorMode || 'swallow', // 'swallow' | 'throw'
    }
    this._reaperCooldownMs = config.reaperCooldownMs ?? 30000
    // Jittered Cooldown Base: Add random offset to avoid synchronized reapers
    this._reaperBaseInterval = this._reaperCooldownMs + Math.random() * (this._reaperCooldownMs / 3)
    this._reaperCurrentInterval = this._reaperBaseInterval
    this._reaperNextRunAt = 0

    // Setup Lease Manager
    const serviceName = config.serviceName || process.env.AWS_LAMBDA_FUNCTION_NAME || 'sls_pg'
    // 48-bit random instance id => exactly 8 base64url chars (no padding). Good entropy, tight budget.
    const instanceId = crypto.randomBytes(6).toString('base64url')
    // Explicit coordination secret (NOT db password).
    const coordinationSecret = config.coordinationSecret
    this._baseApplicationName =
      (typeof config.application_name === 'string' && config.application_name) ||
      (typeof config.applicationName === 'string' && config.applicationName) ||
      serviceName

    if (!coordinationSecret) {
      if (this._leaseMode === 'required') {
        throw new Error('Missing config.coordinationSecret (required for lease/reaper). Set leaseMode=\"optional\" to disable lease/reaper/heartbeat.')
      }
      this._leaseManager = null
      this._reaperEnabled = false
    } else {
      this._leaseManager = new LeaseManager(serviceName, instanceId, coordinationSecret)
    }
    
    // Heartbeat state
    this._leaseExp = 0
    this._heartbeatPromise = null
    this._leaseTtlMs = config.leaseTtlMs ?? 90000
    this._heartbeatSoftRemainingMs = config.heartbeatSoftRemainingMs ?? 30000
    this._heartbeatHardWaitRemainingMs = config.heartbeatHardWaitRemainingMs ?? 5000
    this._heartbeatErrorMode = config.heartbeatErrorMode || 'reconnect' // 'swallow' | 'reconnect' | 'throw'
    this._heartbeatTimeoutMs = config.heartbeatTimeoutMs ?? 2000
    this._defaultQueryTimeoutMs = config.defaultQueryTimeoutMs ?? 0

    // Logging
    this._logger = config.debug ? console.log : () => {}
    this._hooks = config.hooks || {}

    // Backoff state (decorrelated jitter needs previous delay)
    this._connectPrevDelay = 0
    this._queryPrevDelay = 0
    this._maxConnectRetryTimeMs = config.maxConnectRetryTimeMs ?? 15000
    this._maxQueryRetryTimeMs = config.maxQueryRetryTimeMs ?? 15000
  }

  _safeHook(name, payload) {
    const fn = this._hooks && this._hooks[name]
    if (typeof fn !== 'function') return
    try { fn(payload) } catch (_) { /* never throw from hooks */ }
  }

  async connect() {
    if (this._client && !this._isDead) return
    if (this._connectPromise) return this._connectPromise
    const gen = ++this._generation
    this._connectPromise = (async () => {
      try {
        await this._connectWithRetry(gen)
      } finally {
        this._connectPromise = null
      }
    })()
    return this._connectPromise
  }

  async _connectWithRetry(gen) {
    const startedAt = Date.now()
    let retries = 0
    while (true) {
      try {
        await this._connect(gen)
        this._connectPrevDelay = 0
        this._safeHook('onConnect', { gen })
        return // Success
      } catch (err) {
        if (this._maxConnectRetryTimeMs > 0 && (Date.now() - startedAt) > this._maxConnectRetryTimeMs) {
          throw err
        }
        if (!RetryStrategy.isRetryable(err) || retries >= this._retryStrategy.retries) {
          throw err
        }
        retries++
        const delay = RetryStrategy.getBackoff(
          this._retryStrategy.minBackoff,
          this._retryStrategy.maxBackoff,
          this._connectPrevDelay
        )
        this._connectPrevDelay = delay
        this._safeHook('onReconnect', { gen, retries, delay, err })
        this._logger(`Connect Retry ${retries}/${this._retryStrategy.retries} after ${delay}ms: ${err.message}`)
        await new Promise(res => setTimeout(res, delay))
      }
    }
  }

  async _connect(gen) {
    // Internal cleanup before creating a new client should NOT invalidate this generation.
    await this._disposeClient('reconnect', { bumpGeneration: false })

    // Generate initial lease
    let appName = String(this._baseApplicationName || 'app').slice(0, 63)
    if (this._leaseManager) {
      this._leaseExp = Date.now() + this._leaseTtlMs
      appName = this._leaseManager.generateAppName(this._leaseExp)
    } else {
      this._leaseExp = 0
    }
    
    const clientConfig = this._buildPgClientConfig({ application_name: appName })

    const client = new this._library.Client(clientConfig)
    
    // Crash Safety: Swallow errors to prevent Runtime.ExitError
    client.on('error', (err) => this._markDeadAndDispose(client, err, 'error'))
    // If connection ends, the client is not reusable.
    client.on('end', () => this._markDeadAndDispose(client, null, 'end'))

    await client.connect()

    // Generation guard: do not resurrect if a newer generation started while we were connecting.
    if (this._generation !== gen) {
      try { await client.end() } catch (_) {}
      return
    }

    this._client = client
    this._isDead = false

    // Run Reaper if enabled (async, best effort)
    if (this._reaperEnabled) {
      this._reap().catch(err => this._logger('Reap failed:', err.message))
    }
  }

  // Best-effort connection cleanup
  async _reap() {
    // 1. Check Lease Manager
    if (!this._leaseManager) return

    // 2. Jittered Cooldown + Backoff
    const now = Date.now()
    if (now < this._reaperNextRunAt) return
    
    // 3. Use CURRENT client (Single Connection Architecture)
    const client = this._client
    if (!client) return

    try {
      const result = await Reaper.reap(client, this._config, this._leaseManager, this._strategy, this._logger)
      
      if (!result.locked) {
        // Lock busy (someone else is reaping) -> Exponential Backoff
        this._reaperCurrentInterval = Math.min(this._reaperCurrentInterval * 1.5, 600000) // max 10m
      } else {
        // Success (or just acquired lock) -> Reset to Base
        this._reaperCurrentInterval = this._reaperBaseInterval
      }

      // Schedule next run with jitter
      const jitter = Math.random() * (this._reaperCurrentInterval / 2)
      this._reaperNextRunAt = now + this._reaperCurrentInterval + jitter
      
      if (result.killed > 0) {
        this._logger(`Reaper: Killed ${result.killed} zombies`)
      }
    } catch (err) {
      this._logger('Reap failed:', err.message)
    }
  }

  async query(...args) {
    const startedAt = Date.now()
    this._safeHook('onQueryStart', { args, startedAt })
    let retries = 0
    while (true) {
      try {
        if (!this._client || this._isDead) {
          await this.connect()
        } else {
          // Check heartbeat. If lease expired -> WAIT. If OK -> async update.
          await this._heartbeatIfNeeded()
        }

        const res = await this._client.query(...args)
        this._queryPrevDelay = 0
        this._safeHook('onQueryEnd', { args, res, duration: Date.now() - startedAt })
        return res

      } catch (err) {
        // If error is NOT retryable, throw immediately
        if (!RetryStrategy.isRetryable(err) || retries >= this._retryStrategy.retries) {
          this._safeHook('onQueryError', { args, err, duration: Date.now() - startedAt })
          throw err
        }
        if (this._maxQueryRetryTimeMs > 0 && (Date.now() - startedAt) > this._maxQueryRetryTimeMs) {
          this._safeHook('onQueryError', { args, err, duration: Date.now() - startedAt })
          throw err
        }
        
        retries++
        const delay = RetryStrategy.getBackoff(
          this._retryStrategy.minBackoff,
          this._retryStrategy.maxBackoff,
          this._queryPrevDelay
        )
        this._queryPrevDelay = delay
        this._safeHook('onQueryRetry', { retries, delay, err })
        this._logger(`Query Retry ${retries}/${this._retryStrategy.retries} after ${delay}ms: ${err.message}`)
        
        // Force reconnect on next loop
        this._isDead = true
        await this._disposeClient('query_error')
        
        await new Promise(res => setTimeout(res, delay))
      }
    }
  }

  async _heartbeatIfNeeded() {
    if (!this._leaseManager) return
    const gen = this._generation
    const client = this._client
    const now = Date.now()
    const remaining = this._leaseExp - now
    
    // If lease has > 30s remaining, we are safe. Do nothing.
    if (remaining > this._heartbeatSoftRemainingMs) return

    // If lease is expired or close to expiring (< 30s), we need update.
    // Use promise deduplication to avoid thundering herd.
    if (!this._heartbeatPromise) {
      this._heartbeatPromise = this._performHeartbeat(gen, client).finally(() => {
        this._heartbeatPromise = null
      })
    }

    // If lease is ALREADY expired (or < 5s safety margin), we MUST wait for update.
    if (remaining < this._heartbeatHardWaitRemainingMs) {
      await this._heartbeatPromise
    } else {
      // Otherwise, let it update in background (fire-and-forget)
      // This is safe because we still have > 5s lease
    }
  }

  async _performHeartbeat(gen, client) {
    try {
      if (!this._leaseManager) return
      if (!client || client !== this._client) return
      if (this._generation !== gen) return
      const newExp = Date.now() + this._leaseTtlMs
      const appName = this._leaseManager.generateAppName(newExp)
      // Never interpolate appName into SQL. Use bind parameters.
      const heartbeatQuery = this._client.query(`SELECT set_config('application_name', $1, false)`, [appName])
      const timeout = new Promise((_, reject) => {
        const e = new Error(`Heartbeat timed out after ${this._heartbeatTimeoutMs}ms`)
        e.code = 'ETIMEDOUT'
        setTimeout(() => reject(e), this._heartbeatTimeoutMs)
      })
      const res = await Promise.race([heartbeatQuery, timeout])
      if (!res) throw new Error('Heartbeat failed: no result')
      // Only update local lease if DB update succeeded.
      if (this._generation === gen && client === this._client) {
        this._leaseExp = newExp
        this._safeHook('onHeartbeat', { gen })
      }
    } catch (err) {
      this._logger('Heartbeat failed:', err.message)
      this._safeHook('onHeartbeatFail', { gen, err })
      // If we're in hard-wait territory and heartbeat fails, do NOT keep a client that
      // is now invisible to other reapers (lease can expire). Default action: reconnect.
      if (this._heartbeatErrorMode === 'throw') throw err
      if (this._heartbeatErrorMode === 'reconnect') {
        // In soft zone we already decided heartbeat matters. Don't limp along into expiry.
        // If it's retryable, definitely reconnect. If it's non-retryable, reconnect won't help,
        // but it's still safer than staying in an inconsistent lease state.
        this._isDead = true
        await this._disposeClient('heartbeat_failed')
      }
    }
  }

  _buildPgClientConfig(overrides = {}) {
    const clientConfig = { ...this._config, ...overrides }
    if (!clientConfig.query_timeout && this._defaultQueryTimeoutMs > 0) {
      clientConfig.query_timeout = this._defaultQueryTimeoutMs
    }
    // Strip internal fields (keep pg config clean and future-proof)
    const internalKeys = [
      'library',
      'reaper',
      'reaperRunProbability',
      'reaperErrorMode',
      'connUtilization', // legacy alias
      'minConnectionIdleTimeSec',
      'maxIdleConnectionsToKill',
      'retries',
      'minBackoff',
      'maxBackoff',
      'serviceName',
      'coordinationSecret',
      'debug',
      'leaseTtlMs',
      'heartbeatSoftRemainingMs',
      'heartbeatHardWaitRemainingMs',
      'heartbeatErrorMode',
      'heartbeatTimeoutMs',
      'reaperCooldownMs',
      'leaseMode',
      'applicationName',
      'defaultQueryTimeoutMs',
      'hooks',
      'maxConnectRetryTimeMs',
      'maxQueryRetryTimeMs',
    ]
    for (const k of internalKeys) delete clientConfig[k]
    return clientConfig
  }

  async _disposeClient(reason, { bumpGeneration = true } = {}) {
    if (bumpGeneration) this._generation++
    const old = this._client
    this._client = null
    if (!old) return
    try {
      await old.end()
    } catch (_) {
      // ignore
    }
  }

  _markDeadAndDispose(client, err, source) {
    // Never throw from event handlers (Lambda crash safety).
    this._isDead = true
    // Invalidate any in-flight connect/heartbeat on older generations.
    this._generation++
    // Atomically detach the client if it is the current one.
    if (this._client === client) {
      this._client = null
    }
    if (err) {
      const meta = {
        code: err.code,
        sqlstate: err.sqlstate,
        errno: err.errno,
        syscall: err.syscall,
        address: err.address,
        port: err.port,
        severity: err.severity,
        routine: err.routine,
      }
      this._logger(`WARN: pg client ${source} (swallowed):`, err.message || err.code, meta)
      this._safeHook('onClientDead', { source, err, meta })
    }
    // Best-effort close; do not await.
    try {
      client.end().catch(() => {})
    } catch (_) {}
  }

  async clean() {
    // Try to close gracefully
    await this._disposeClient('clean')
  }
  
  async end() {
    return this.clean()
  }

  getClient() {
    return this._client
  }
}

module.exports = AequorClient
