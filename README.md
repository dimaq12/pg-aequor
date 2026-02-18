<p align="center">
  <img src="assets/pg-aequor-banner.png" alt="PG-Aequor banner" width="720" />
</p>

# pg-aequor

Crash-safe PostgreSQL client for **Serverless runtimes** (AWS Lambda / similar).

Standard `pg` + Lambda scale-outs often ends in **zombie connections**: a Lambda freezes, its TCP socket stays alive on the DB, and a new wave of invocations keeps opening more connections until you hit `max_connections`.

`pg-aequor` prevents this using **Signed Leases** + a lightweight **Distributed Reaper**.

## Features

- **Signed leases in `application_name`**: each connection self-identifies with expiration + HMAC.
- **Distributed reaper**: one request occasionally becomes the “leader” and reaps expired connections.
- **Advisory locks**: coordination via Postgres locks (no external coordinator).
- **Crash safety**: socket errors are swallowed from event handlers to prevent runtime crashes.
- **Safe retries**: decorrelated jitter + SQLSTATE filtering for transient failures.
- **Hooks**: lightweight observability callbacks (metrics/tracing).

## Install

```bash
npm install pg-aequor pg
```

> `pg` is a **peer dependency**. Tested with `pg@^8.11.0`.

## Quick start

```js
const { ServerlessClient } = require('pg-aequor')

const client = new ServerlessClient({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // Coordination Secret (distinct from DB password)
  secret: process.env.COORD_SECRET,
})

await client.connect()
const res = await client.query('SELECT NOW()')
await client.clean() // or: await client.end()
```

## How it works (in one minute)

In standard environments, connections live long. In serverless, containers “freeze”.

We solve this via:

1. **Signed Leases**: each connection stores `expiration + signature` in `application_name`.
2. **Distributed Reaper**: on connect (probabilistically), one instance scans `pg_stat_activity` and terminates expired connections.
3. **Advisory Locks**: `pg_try_advisory_lock` ensures only one leader reaps at a time.

## Operational rules (important)

- **Disposable idle**: if a connection is idle longer than its lease TTL, it becomes eligible to be reaped by another instance.
- **Single-connection architecture**: the reaper runs on the active connection (under lock) to avoid “reaper storms”.
- **Hooks must be fast**: don’t do heavy work inside hooks; use them for metrics/tracing only.

## Configuration

### Lease / reaper (recommended)

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `secret` | `string` | _(required)_ | Shared secret for HMAC signing. **Do not** use DB password. Must be at least 16 bytes. |
| `leaseMode` | `'required' \| 'optional'` | `'required'` | If `optional` and `secret` is missing: lease/reaper/heartbeat are disabled. |
| `leaseTtlMs` | `number` | `90000` | Lease TTL. |
| `reaper` | `boolean` | `true` | Enable/disable reaper. |
| `reaperRunProbability` | `number` | `0.1` | Probability of trying a reaper pass on connect (0..1). |
| `reaperCooldownMs` | `number` | `30000` | Minimum time between reaper runs per container. |
| `minConnectionIdleTimeSec` | `number` | `180` | Minimum idle seconds to consider a connection a candidate. |
| `maxIdleConnectionsToKill` | `number` | `10` | Max zombies to kill in one pass. |

### Retries

| Option | Type | Default |
| --- | --- | --- |
| `retries` | `number` | `3` |
| `minBackoff` | `number` | `100` |
| `maxBackoff` | `number` | `2000` |
| `maxConnectRetryTimeMs` | `number` | `15000` |
| `maxQueryRetryTimeMs` | `number` | `15000` |

We use **decorrelated jitter** and **SQLSTATE-based** retry classification to avoid duplicating non-idempotent writes.

## Observability (hooks)

```js
const { ServerlessClient } = require('pg-aequor')

const client = new ServerlessClient({
  // ...pg config...
  secret: process.env.COORD_SECRET,

  hooks: {
    onQueryRetry: ({ retries, err }) => {
      console.warn(`Retry #${retries} due to ${err.code}`)
    },
    onClientDead: ({ source, meta }) => {
      // Great place for EMF/X-Ray/etc
      console.log('Client dead:', source, meta?.sqlstate)
    },
    onQueryStart: ({ startedAt }) => {
      // tracing start
    },
    onQueryEnd: ({ duration }) => {
      // tracing end
    },
  },
})
```

## FAQ

### Will it kill my active connections?

No. The reaper only terminates connections that:

- match this service prefix, and
- have a **valid signature**, and
- are **expired**, and
- are **idle** for longer than your configured threshold.

### Do I still need PgBouncer/RDS Proxy?

If you already have a proxy and it works well for you, keep it. `pg-aequor` is a pure-client approach intended for cases where you can’t or don’t want to add extra infrastructure.
