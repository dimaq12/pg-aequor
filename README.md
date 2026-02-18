<p align="center">
  <img src="assets/pg-aequor-banner.png" alt="PG-Aequor banner" width="720" />
</p>

<p align="center">
  <a href="https://github.com/dimaq12/pg-aequor/actions/workflows/ci.yml">
    <img alt="CI" src="https://github.com/dimaq12/pg-aequor/actions/workflows/ci.yml/badge.svg" />
  </a>
  <a href="https://www.npmjs.com/package/pg-aequor">
    <img alt="npm" src="https://img.shields.io/npm/v/pg-aequor.svg" />
  </a>
  <a href="./LICENSE">
    <img alt="license" src="https://img.shields.io/npm/l/pg-aequor.svg" />
  </a>
</p>

<h1 align="center">pg-aequor</h1>

<p align="center">
  Crash-safe PostgreSQL client for <strong>Serverless runtimes</strong> (AWS Lambda / similar).
</p>

Standard <code>pg</code> + Lambda scale-outs often end in <strong>zombie connections</strong>:
a Lambda freezes, its TCP socket stays alive on the DB, and a new wave of invocations keeps opening connections until you hit <code>max_connections</code>.

<strong>pg-aequor</strong> prevents this using <strong>Signed Leases</strong> + a lightweight <strong>Distributed Reaper</strong>.

## Table of contents

- [Features](#features)
- [Install](#install)
- [Quick start](#quick-start)
- [How it works](#how-it-works-in-one-minute)
- [Operational rules](#operational-rules-important)
- [Configuration](#configuration)
- [Observability (hooks)](#observability-hooks)
- [Production checklist](#production-checklist)
- [FAQ](#faq)

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

> **Note:** `pg` is a peer dependency. Tested with `pg@^8.11.0`.

## Quick start

```js
const { ServerlessClient } = require('pg-aequor')

const client = new ServerlessClient({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  // Coordination Secret (distinct from DB password)
  coordinationSecret: process.env.COORD_SECRET,
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

<details>
  <summary><strong>Lease / reaper (recommended)</strong></summary>

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `coordinationSecret` | `string` | _(required)_ | Shared secret for HMAC signing. **Do not** use DB password. Must be at least 16 bytes. |
| `leaseMode` | `'required' \| 'optional'` | `'required'` | If `optional` and `coordinationSecret` is missing: lease/reaper/heartbeat are disabled. |
| `leaseTtlMs` | `number` | `90000` | Lease TTL. |
| `reaper` | `boolean` | `true` | Enable/disable reaper. |
| `reaperRunProbability` | `number` | `0.1` | Probability of trying a reaper pass on connect (0..1). |
| `reaperCooldownMs` | `number` | `30000` | Minimum time between reaper runs per container. |
| `minConnectionIdleTimeSec` | `number` | `180` | Minimum idle seconds to consider a connection a candidate. |
| `maxIdleConnectionsToKill` | `number` | `10` | Max zombies to kill in one pass. |

</details>

<details>
  <summary><strong>Retries</strong></summary>

| Option | Type | Default |
| --- | --- | --- |
| `retries` | `number` | `3` |
| `minBackoff` | `number` | `100` |
| `maxBackoff` | `number` | `2000` |
| `maxConnectRetryTimeMs` | `number` | `15000` |
| `maxQueryRetryTimeMs` | `number` | `15000` |

We use **decorrelated jitter** and **SQLSTATE-based** retry classification to avoid duplicating non-idempotent writes.

</details>

## Observability (hooks)

```js
const { ServerlessClient } = require('pg-aequor')

const client = new ServerlessClient({
  // ...pg config...
  coordinationSecret: process.env.COORD_SECRET,

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

## Production checklist

### Required Postgres privileges

The reaper reads `pg_stat_activity` and calls `pg_terminate_backend()`.

> **Heads up:** on managed Postgres, this may require elevated privileges (or be restricted by policy).
> If the reaper can’t terminate backends, you’ll typically see permission errors and zombies will remain.

### Coordination secret hygiene

- Use a **separate secret** (not the DB password).
- Keep it at least **16 bytes**.
- Rotate carefully: a safe pattern is “deploy new secret everywhere” during a maintenance window, because old/new secrets won’t verify each other’s leases.

### Recommended defaults

- Start with a conservative `leaseTtlMs` (e.g. `90s`) and `minConnectionIdleTimeSec` (e.g. `180s`) to avoid self-inflicted churn.
- Keep hooks lightweight (metrics only).

## FAQ

### Will it kill my active connections?

No. The reaper only terminates connections that:

- match this service prefix, and
- have a **valid signature**, and
- are **expired**, and
- are **idle** for longer than your configured threshold.

### Do I still need PgBouncer/RDS Proxy?

If you already have a proxy and it works well for you, keep it. `pg-aequor` is a pure-client approach intended for cases where you can’t or don’t want to add extra infrastructure.
