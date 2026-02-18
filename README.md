# pg-aequor

If you use standard `pg` in AWS Lambda, you are either a madman or you haven't yet seen your database die under a pile of zombie connections. This library is a wrapper that forces PostgreSQL and Serverless to coexist in peace.

---

## Why isn't this just another wrapper?

In standard environments, connections live long. In Lambda, they "freeze" in suspended instances. We solve this via **Signed Leases**:

1.  **Signed Leases**: Each connection signs itself in `application_name` (expiration + HMAC).
2.  **Distributed Reaper**: A background "Reaper" scans the database and kills connections whose lease has expired.
3.  **Advisory Locks**: Coordination is handled via Postgres Advisory Locks, so instances don't fight each other to clean up the mess.

---

## Technical Rules (Read this so it doesn't hurt)

*   **Disposable Idle**: If a connection is idle longer than the lease TTL, it is considered a corpse. Another instance will kill it. This is a feature, not a bug.
*   **Crash Safety**: We swallow socket errors in `pg.Client` handlers. No more `Runtime.ExitError` crashing your entire Lambda.
*   **Single Connection Architecture**: The Reaper runs on the *active* connection using Advisory Locks. It adds minimal latency to the "leader" request but prevents connection storms (Reaper-DOS) during massive scale-ups.

---

## Configuration

### Required Parameters (Lease/Reaper)

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `secret` | `string` | **Critical.** Shared secret for HMAC signing. Do NOT use your DB password. Must be at least 16 bytes. |
| `leaseMode` | `string` | `'required'` (throws without secret) or `'optional'`. Default: `'required'`. |
| `leaseTtlMs` | `number` | Lease Time-To-Live in milliseconds. Default: `90000` (90s). |

### Retry Strategy

We use **Decorrelated Jitter** and **SQLSTATE** filtering. Retries trigger only on transient errors (network, DB restart, connection limits).

---

## Observability (Hooks)

Do not put heavy logic in hooks. Use them for metrics.

```javascript
const { ServerlessClient } = require('pg-aequor')

const client = new ServerlessClient({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  
  // Coordination Secret (Distinct from DB password)
  secret: process.env.COORD_SECRET,

  hooks: {
    onQueryRetry: ({ retries, err }) => {
      console.warn(`Retry #${retries} due to ${err.code}`)
    },
    onClientDead: ({ source, meta }) => {
      // Perfect for CloudWatch EMF or X-Ray
      logToEMF('ClientDeath', 1, { sqlstate: meta?.sqlstate })
    }
  }
})

await client.connect()
const res = await client.query('SELECT NOW()')
await client.clean() // or await client.end()
```

---

## Installation

```bash
npm install pg-aequor
```

> **Attention:** This library requires `pg` as a peer dependency. Tested on versions `^8.11.0`.
