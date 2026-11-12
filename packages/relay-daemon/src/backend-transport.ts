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
// answering with 5xx, with capped exponential backoff. Client errors (4xx,
// e.g. a rejected token) are fatal and propagate immediately.
const BACKEND_RECONNECT_MAX_DELAY_MS = 1_500;
const BACKEND_RECONNECT_BASE_DELAY_MS = 200;

export function backendReconnectDelayMs(attempt: number, random = Math.random): number {
  const ceiling = Math.min(
    BACKEND_RECONNECT_BASE_DELAY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 3),
    BACKEND_RECONNECT_MAX_DELAY_MS,
  );
  // Equal jitter keeps a meaningful lower bound while spreading reconnecting daemons.
  return Math.round(ceiling * (0.5 + random() * 0.5));
}

export async function withBackendReconnect<T>(
  action: () => Promise<T>,
  logger: Pick<DaemonLogger, "warn">,
  context: { sandboxId: string; what: string },
  control: {
    signal?: AbortSignal;
    shouldStop?: () => boolean;
    onTransientFailure?: () => void;
    onCredentialRejected?: () => void;
  } = {},
): Promise<T> {
  let attempt = 0;
  while (true) {
    if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
    try {
      return await action();
    } catch (error) {
      if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
      if (error instanceof DaemonHttpError && error.status < 500 && error.status !== 408 && error.status !== 429) {
        // Only the backend itself revoking credentials speaks for ownership. A
        // proxy's 403/404 mid-deploy says nothing about it, so it neither ends
        // nor starts an outage grace.
        if (error.status === 401 || error.status === 410) control.onCredentialRejected?.();
        throw error;
      }
      control.onTransientFailure?.();
      attempt += 1;
      const message = transportErrorDetail(error);
      const backoff = Math.max(backendReconnectDelayMs(attempt), error instanceof DaemonHttpError ? error.retryAfterMs : 0);
      logger.warn(`${context.what} failed; retrying`, {
        sandboxId: context.sandboxId,
        error: message,
        attempt,
        backoffMs: backoff,
      });
      try {
        await delay(backoff, control.signal);
      } catch (delayError) {
        if (control.signal?.aborted || control.shouldStop?.()) throw new DaemonStoppedError();
        throw delayError;
      }
    }
  }
}

export async function postJson(fetchFn: typeof fetch, url: string, body: unknown, token?: string, signal?: AbortSignal): Promise<void> {
  await postJsonRequest(fetchFn, url, body, token, signal);
}

export async function postJsonResponse<T>(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await postJsonRequest(fetchFn, url, body, token, signal);
  return await response.json() as T;
}

export async function postJsonRequest(
  fetchFn: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
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
      await postJson(fetchFn, url, body, token, signal);
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
