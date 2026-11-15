import { EVENT_REQUEST_TIMEOUT_MS } from './event-request-policy.js';
import type { DaemonLogger, DaemonLogFields } from './index.js';
import { persistTerminalEvent, queuesOutputForReplay } from './terminal-outbox.js';
import { responseErrorDetail, transportErrorDetail } from './http-error-detail.js';
import { retryAfterMs } from './transport-retry.js';

const REQUEST_TIMEOUT_MS = 2_000;

export function requestSignal(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class DaemonHttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs = 0) {
    super(message);
    this.name = "DaemonHttpError";
  }
}

export class DaemonStoppedError extends Error {
  constructor() {
    super("Relay daemon stopped.");
    this.name = "DaemonStoppedError";
  }
}


// Retries `action` while the backend is unreachable (network errors) or
// answering with 5xx, with jittered exponential backoff. A blip or a backend
// restart is retried quickly; a sustained outage backs off further, and a
// `wake` (a heartbeat that got through, the computer resuming from sleep)
// cuts the wait short so recovery never waits out a long delay.
const BACKEND_RECONNECT_BASE_DELAY_MS = 200;
const BACKEND_RECONNECT_MAX_DELAY_MS = 1_500;
/** Attempts kept at the quick ceiling: about half a minute, a restart or deploy. */
const BACKEND_RECONNECT_QUICK_ATTEMPTS = 20;
const BACKEND_OUTAGE_MAX_DELAY_MS = 15_000;
/** How often a retry that keeps failing repeats its warning after the first. */
const BACKEND_RECONNECT_LOG_INTERVAL_MS = 30_000;
/** The least a lone 401 waits before the request that confirms it. */
const CREDENTIAL_CONFIRM_DELAY_MS = 500;

export function backendReconnectDelayMs(attempt: number, random = Math.random): number {
  const ceiling = attempt <= BACKEND_RECONNECT_QUICK_ATTEMPTS
    ? Math.min(BACKEND_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 3), BACKEND_RECONNECT_MAX_DELAY_MS)
    : Math.min(BACKEND_RECONNECT_MAX_DELAY_MS * 2 ** Math.min(attempt - BACKEND_RECONNECT_QUICK_ATTEMPTS, 4), BACKEND_OUTAGE_MAX_DELAY_MS);
  // Equal jitter keeps a meaningful lower bound while spreading reconnecting daemons.
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

/** Lets one loop end another's wait early: `notify` resolves every pending `wait`. */
export class Wakeup {
  private readonly waiters = new Set<() => void>();

  notify(): void {
    for (const wake of [...this.waiters]) wake();
  }

  /** Resolves after `ms` or on `notify`, whichever is first; rejects when `signal` aborts. */
  async wait(ms: number, signal?: AbortSignal): Promise<void> {
    const woken = new AbortController();
    const wake = (): void => woken.abort();
    this.waiters.add(wake);
    try {
      await delay(ms, signal ? AbortSignal.any([signal, woken.signal]) : woken.signal);
    } catch (error) {
      if (signal?.aborted || !woken.signal.aborted) throw error;
    } finally {
      this.waiters.delete(wake);
    }
  }
}

/** A status the backend (or something in front of it) answered that a retry may outlast. */
function isTransientStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429;
}

export async function withBackendReconnect<T>(
  action: () => Promise<T>,
  logger: Pick<DaemonLogger, "warn"> & Partial<Pick<DaemonLogger, "info">>,
  context: { sandboxId: string; what: string },
  control: {
    signal?: AbortSignal;
    shouldStop?: () => boolean;
    onTransientFailure?: () => void;
    onCredentialRejected?: () => void;
    /** Ends ordinary backoff early; a server's Retry-After remains a minimum. */
    wake?: Wakeup;
    /**
     * How long a refusal that is not about the credential (a proxy's 403/404
     * mid-deploy) is retried before it fails. For a daemon that is already
     * serving: stopping it over one answer would stop its runs. Unset, the
     * first refusal fails.
     */
    rejectionGraceMs?: number;
    /**
     * Require a 401 to repeat before it counts as a rejected credential. For
     * the daemon's own identity, where acting on it is permanent; a request
     * made for one run fails that run on the first 401.
     */
    confirmUnauthorized?: boolean;
  } = {},
): Promise<T> {
  let attempt = 0;
  let unauthorized = 0;
  let firstFailureAt: number | undefined;
  let firstRejectionAt: number | undefined;
  let lastLoggedAt: number | undefined;
  while (true) {
    if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
    try {
      const result = await action();
      if (firstFailureAt !== undefined) {
        logger.info?.(`${context.what} recovered`, {
          sandboxId: context.sandboxId, attempts: attempt, outageMs: Math.round(performance.now() - firstFailureAt),
        });
      }
      return result;
    } catch (error) {
      if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
      let minimumDelayMs = error instanceof DaemonHttpError ? error.retryAfterMs : 0;
      if (error instanceof DaemonHttpError && !isTransientStatus(error.status)) {
        // Only the backend itself revoking credentials speaks for ownership. A
        // proxy's 403/404 mid-deploy says nothing about it, so it neither ends
        // nor starts an outage grace.
        const credential = error.status === 401 || error.status === 410;
        const unconfirmed = error.status === 401 && unauthorized === 0 && control.confirmUnauthorized === true;
        if (credential && !unconfirmed) control.onCredentialRejected?.();
        if (unconfirmed) {
          // Gone is the backend's own tombstone. A lone 401 can also come from
          // an auth proxy or a lagging replica, and acting on it stops this
          // computer for good, so it must repeat before it counts.
          unauthorized += 1;
          minimumDelayMs = Math.max(minimumDelayMs, CREDENTIAL_CONFIRM_DELAY_MS);
        } else {
          firstRejectionAt ??= performance.now();
          const withinGrace = !credential && control.rejectionGraceMs !== undefined
            && performance.now() - firstRejectionAt < control.rejectionGraceMs;
          if (!withinGrace) throw error;
        }
      } else {
        unauthorized = 0;
        control.onTransientFailure?.();
      }
      attempt += 1;
      const now = performance.now();
      firstFailureAt ??= now;
      const backoff = Math.max(backendReconnectDelayMs(attempt), minimumDelayMs);
      // The first failure and then one line per interval: an outage that lasts
      // an hour is one fact, not thousands of warnings.
      if (lastLoggedAt === undefined || now - lastLoggedAt >= BACKEND_RECONNECT_LOG_INTERVAL_MS) {
        lastLoggedAt = now;
        logger.warn(`${context.what} failed; retrying`, {
          sandboxId: context.sandboxId,
          error: transportErrorDetail(error),
          attempt,
          backoffMs: backoff,
          ...(attempt > 1 ? { outageMs: Math.round(now - firstFailureAt) } : {}),
        });
      }
      try {
        if (control.wake) await control.wake.wait(backoff, control.signal);
        else await delay(backoff, control.signal);
        // A healthy heartbeat proves reachability, but not that this endpoint
        // is ready for another request. Honor its minimum even after a wake.
        const retryAt = now + minimumDelayMs;
        while (performance.now() < retryAt) {
          await delay(retryAt - performance.now(), control.signal);
        }
      } catch (delayError) {
        if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
        throw delayError;
      }
    }
  }
}

export async function postJson(fetchFn: typeof fetch, url: string, body: unknown, token?: string, signal?: AbortSignal, timeoutMs?: number): Promise<void> {
  await postJsonRequest(fetchFn, url, body, token, signal, timeoutMs);
}

export async function postJsonResponse<T>(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const response = await postJsonRequest(fetchFn, url, body, token, signal, timeoutMs);
  return await response.json() as T;
}

export async function postJsonRequest(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
  timeoutMs?: number,
): Promise<Response> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal(signal, timeoutMs),
  });
  if (!response.ok) {
    throw new DaemonHttpError(`POST ${url} failed: ${response.status} ${await responseErrorDetail(response)}`, response.status, retryAfterMs(response.headers.get("Retry-After")));
  }
  return response;
}


/**
 * A definite refusal of one output batch (a 4xx other than the transient or
 * credential ones). postJsonWithRetry already retried everything else.
 */
export function isRejectedOutputBatch(error: unknown): error is DaemonHttpError {
  return error instanceof DaemonHttpError
    && error.status >= 400 && error.status < 500
    && ![401, 408, 410, 429].includes(error.status);
}

const EVENT_POST_RETRY_INITIAL_DELAY_MS = 200;
const EVENT_POST_RETRY_MAX_DELAY_MS = 1_500;
/** How often a post that keeps failing repeats its warning after the first. */
const EVENT_POST_RETRY_LOG_INTERVAL_MS = 30_000;
interface EventPostFailure {
  attempt: number;
  status?: number;
  error: string;
  backoffMs: number;
}

/**
 * A retry reporter for one event post: warns on the first failure and then at
 * most once per interval, with the status and attempt count, so a post the
 * backend keeps refusing is never silent and never floods the log.
 */
export function eventPostRetryLogger(
  logger: DaemonLogger,
  fields: DaemonLogFields,
  intervalMs = EVENT_POST_RETRY_LOG_INTERVAL_MS,
): (failure: EventPostFailure) => void {
  let lastLoggedAt: number | undefined;
  return (failure) => {
    const now = Date.now();
    if (lastLoggedAt !== undefined && now - lastLoggedAt < intervalMs) return;
    lastLoggedAt = now;
    logger.warn("event post failed; retrying", { ...fields, ...failure });
  };
}

export async function postJsonWithRetry(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token: string,
  signal?: AbortSignal,
  onRetry?: (failure: EventPostFailure) => void,
): Promise<void> {
  await persistTerminalEvent(fetchFn, body);
  // Negotiated peers upload captured output through one bounded replay batch
  // instead of serial per-chunk requests competing with replay at every RTT.
  if (queuesOutputForReplay(fetchFn, body)) return;
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error("Aborted before event post.");
    try {
      await postJson(fetchFn, url, body, token, signal, EVENT_REQUEST_TIMEOUT_MS);
      return;
    } catch (error) {
      if (error instanceof DaemonHttpError && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      const backoff = Math.max(Math.min(EVENT_POST_RETRY_INITIAL_DELAY_MS * 2 ** Math.min(attempt, 5), EVENT_POST_RETRY_MAX_DELAY_MS) * (0.5 + Math.random() * 0.5), error instanceof DaemonHttpError ? error.retryAfterMs : 0);
      attempt += 1;
      if (!signal?.aborted) {
        onRetry?.({
          attempt,
          ...(error instanceof DaemonHttpError ? { status: error.status } : {}),
          error: transportErrorDetail(error),
          backoffMs: backoff,
        });
      }
      await delay(backoff, signal);
    }
  }
}

export async function getJson(fetchFn: typeof fetch, url: string, token?: string, signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
  return fetchFn(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    signal: requestSignal(signal, timeoutMs),
  });
}



export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Delay aborted."));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new Error("Delay aborted."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
