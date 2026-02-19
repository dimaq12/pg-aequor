import { Client, ClientConfig, QueryResult, QueryResultRow } from 'pg';

export interface AequorClientHooks {
  /**
   * Called when a new database connection is successfully established.
   */
  onConnect?: (payload: { gen: number }) => void;

  /**
   * Called when a connection attempt fails and is about to be retried.
   */
  onReconnect?: (payload: { gen: number; retries: number; delay: number; err: Error }) => void;

  /**
   * Called when a query fails with a retryable error and is about to be retried.
   */
  onQueryRetry?: (payload: { retries: number; delay: number; err: Error }) => void;

  /**
   * Called when a heartbeat (lease renewal) succeeds.
   */
  onHeartbeat?: (payload: { gen: number }) => void;

  /**
   * Called when a heartbeat fails (either transiently or permanently).
   */
  onHeartbeatFail?: (payload: { gen: number; err: Error }) => void;

  /**
   * Called when a reaper pass is attempted (best effort).
   * Useful for metrics: how many zombies were killed and how long it took.
   */
  onReap?: (payload: { gen: number; locked: boolean; killed: number; durationMs: number }) => void;

  /**
   * Called when the underlying pg.Client emits an 'error' event or ends unexpectedly.
   * This is a critical signal that the connection is dead.
   */
  onClientDead?: (payload: { source: 'error' | 'end'; err?: Error; meta?: { sqlstate?: string; [key: string]: any } }) => void;

  /**
   * Called immediately before a user query is executed. Useful for tracing start time.
   */
  onQueryStart?: (payload: { args: any[]; startedAt: number }) => void;

  /**
   * Called immediately after a user query successfully completes.
   */
  onQueryEnd?: (payload: { args: any[]; res: QueryResult<any>; duration: number }) => void;

  /**
   * Called when a user query fails (before retry logic kicks in).
   */
  onQueryError?: (payload: { args: any[]; err: Error; duration: number }) => void;
}

export interface AequorClientConfig extends ClientConfig {
  /**
   * Shared coordination secret for signing leases. Required if leaseMode is 'required'.
   * Conceptually distinct from DB password. Must be at least 16 bytes.
   */
  coordinationSecret?: string;

  /**
   * Logical name of the service using this client. Used for advisory lock namespace.
   * Defaults to AWS_LAMBDA_FUNCTION_NAME or 'sls_pg'.
   */
  serviceName?: string;

  /**
   * Coordination mode.
   * - 'required': throws if coordinationSecret is missing (default).
   * - 'optional': disables lease/reaper if coordinationSecret is missing.
   */
  leaseMode?: 'required' | 'optional';

  /**
   * Enable/disable the background connection reaper. Default: true.
   */
  reaper?: boolean;

  /**
   * Probability (0.0 - 1.0) of running the reaper on connect.
   * Alias for legacy 'connUtilization'. Default: 0.1.
   */
  reaperRunProbability?: number;

  /**
   * Minimum time (ms) between reaper runs on this container. Default: 120000 (2m).
   */
  reaperCooldownMs?: number;

  /**
   * How to handle reaper internal errors.
   * - 'swallow': log and ignore (default).
   * - 'throw': throw exception to the caller.
   */
  reaperErrorMode?: 'swallow' | 'throw';

  /**
   * Minimum idle time (seconds) before a connection is considered a zombie candidate.
   * Default: 180 (3m).
   */
  minConnectionIdleTimeSec?: number;

  /**
   * Maximum number of zombie connections to kill in one reaper pass. Default: 1.
   */
  maxIdleConnectionsToKill?: number;

  /**
   * Lease time-to-live in milliseconds. Default: 90000 (90s).
   */
  leaseTtlMs?: number;

  /**
   * Time remaining (ms) where we soft-check lease renewal. Default: 30000.
   */
  heartbeatSoftRemainingMs?: number;

  /**
   * Time remaining (ms) where we force-wait for lease renewal. Default: 5000.
   */
  heartbeatHardWaitRemainingMs?: number;

  /**
   * Time (ms) to wait for set_config heartbeat query before timing out. Default: 2000.
   */
  heartbeatTimeoutMs?: number;

  /**
   * Action on heartbeat failure.
   * - 'reconnect': mark client dead and reconnect (safest for serverless).
   * - 'swallow': log and ignore.
   * - 'throw': throw error.
   * Default: 'reconnect'.
   */
  heartbeatErrorMode?: 'reconnect' | 'swallow' | 'throw';

  /**
   * Max time (ms) to spend retrying a connect operation. Default: 15000.
   */
  maxConnectRetryTimeMs?: number;

  /**
   * Max time (ms) to spend retrying a query operation. Default: 15000.
   */
  maxQueryRetryTimeMs?: number;

  /**
   * Default query_timeout (ms) passed to pg if not specified in individual query.
   */
  defaultQueryTimeoutMs?: number;

  /**
   * Observability hooks.
   */
  hooks?: AequorClientHooks;

  /**
   * Debug logging (console.log). Default: false.
   */
  debug?: boolean;

  /**
   * Underlying pg driver instance (e.g. for X-Ray capture).
   */
  library?: any;

  // Legacy aliases
  connUtilization?: number;
  applicationName?: string;
}

export class AequorClient {
  constructor(config: AequorClientConfig);

  /**
   * Establishes a connection (if not already connected) and acquires a lease.
   */
  connect(): Promise<void>;

  /**
   * Executes a query with automatic retry and lease management.
   */
  query<R extends QueryResultRow = any, I extends any[] = any[]>(
    queryTextOrConfig: string | import('pg').QueryConfig<I>,
    values?: I
  ): Promise<QueryResult<R>>;

  /**
   * Gracefully closes the connection.
   */
  clean(): Promise<void>;

  /**
   * Alias for clean().
   */
  end(): Promise<void>;
  
  /**
   * Returns the underlying pg.Client instance (if connected).
   * Use with caution.
   */
  getClient(): Client | null;
}
