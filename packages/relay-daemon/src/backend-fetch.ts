import { EnvHttpProxyAgent } from 'undici';
import { transportErrorDetail } from './http-error-detail.js';

const HTTP2_FAILURE_LIMIT = 3;
const HTTP2_FAILURE_WINDOW_MS = 5 * 60_000;
interface OriginTransport {
  dispatcher: EnvHttpProxyAgent;
  failures: number[];
  http1: boolean;
}
/** `reset`: the peer failed the HTTP/2 stream or connection. `stall`: it went silent until a deadline. */
export type TransportFailure = 'reset' | 'stall';
export interface TransportRecovery {
  origin: string;
  method: string;
  path: string;
  elapsedMs: number;
  requestBytes?: number;
  cause: TransportFailure;
  http2Failures: number;
  protocol: 'http/2' | 'http/1.1';
  error: string;
}
export interface BackendFetchOptions {
  /** Prefer HTTP/2 when the server negotiates it. Defaults to `RELAY_DAEMON_HTTP_PROTOCOL`. */
  http2?: boolean;
}

/** HTTP/1.1 unless `RELAY_DAEMON_HTTP_PROTOCOL=http2`: one request per connection, so a
 *  cancelled or timed-out request closes its socket instead of resetting a shared stream. */
export function backendHttp2Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RELAY_DAEMON_HTTP_PROTOCOL?.trim().toLowerCase() === 'http2';
}

function isTimeout(reason: unknown): boolean {
  return typeof reason === 'object' && reason !== null && (reason as { name?: unknown }).name === 'TimeoutError';
}

function http2Failure(error: unknown, signal: AbortSignal | null | undefined): TransportFailure | undefined {
  // A deadline is the only evidence a silent peer leaves; any other abort is the caller's choice.
  if (signal?.aborted) return isTimeout(signal.reason) ? 'stall' : undefined;
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 16) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const detail = item as { code?: unknown; message?: unknown; cause?: unknown };
    if (typeof detail.code === 'string') {
      if (detail.code.startsWith('ERR_HTTP2_')) return 'reset';
      // Undici reports GOAWAY, frame errors, and streams closed before a response
      // under its own codes; its `HTTP/2:` prefix tells them from HTTP/1.1 socket loss.
      if ((detail.code === 'UND_ERR_SOCKET' || detail.code === 'UND_ERR_INFO')
        && typeof detail.message === 'string' && detail.message.startsWith('HTTP/2:')) return 'reset';
      if (detail.code === 'UND_ERR_HEADERS_TIMEOUT') return 'stall';
    }
    pending.push(detail.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 8));
  }
  return undefined;
}

/**
 * One dedicated pool per origin. HTTP/1.1 by default; with HTTP/2 enabled, replace a
 * failed or stalled pool, then fall back per origin until restart.
 */
export function createBackendFetch(
  onRecovery?: (recovery: TransportRecovery) => void,
  options: BackendFetchOptions = {},
): typeof fetch {
  const http2 = options.http2 ?? backendHttp2Enabled();
  const origins = new Map<string, OriginTransport>();
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const origin = url.origin;
    const startedAt = performance.now();
    let state = origins.get(origin);
    if (!state) {
      state = { dispatcher: new EnvHttpProxyAgent({ allowH2: http2 }), failures: [], http1: !http2 };
      origins.set(origin, state);
    }
    const dispatcher = state.dispatcher;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      return await fetch(input, { ...init, dispatcher } as RequestInit);
    } catch (error) {
      const cause = !state.http1 && state.dispatcher === dispatcher ? http2Failure(error, signal) : undefined;
      if (cause) {
        const now = performance.now();
        // Successful heartbeats between failing uploads must not erase a
        // recurring fault. Only a quiet interval ages failures out.
        state.failures = state.failures.filter(at => now - at < HTTP2_FAILURE_WINDOW_MS);
        // A stall may be the backend or the network rather than HTTP/2, so it earns
        // a fresh connection but never spends the fallback budget.
        if (cause === 'reset') state.failures.push(now);
        state.http1 = state.failures.length >= HTTP2_FAILURE_LIMIT;
        state.dispatcher = new EnvHttpProxyAgent({ allowH2: !state.http1 });
        // Let in-flight requests finish under their own deadlines. Never replay
        // a POST here: the existing caller/outbox owns retries and deduplication.
        void dispatcher.close().catch(() => undefined);
        onRecovery?.({ origin, path: url.pathname,
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          elapsedMs: Math.round(now - startedAt),
          ...(typeof init?.body === 'string' ? { requestBytes: Buffer.byteLength(init.body) } : {}),
          cause, http2Failures: state.failures.length,
          protocol: state.http1 ? 'http/1.1' : 'http/2', error: transportErrorDetail(error) });
      }
      throw error;
    }
  };
}
