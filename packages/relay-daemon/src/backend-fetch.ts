import { EnvHttpProxyAgent } from 'undici';
import { transportErrorDetail } from './http-error-detail.js';

const HTTP2_FAILURE_LIMIT = 3;
const HTTP2_FAILURE_WINDOW_MS = 5 * 60_000;
interface OriginTransport {
  dispatcher: EnvHttpProxyAgent;
  failures: number[];
  http1: boolean;
}
export interface TransportRecovery {
  origin: string;
  method: string;
  path: string;
  elapsedMs: number;
  requestBytes?: number;
  http2Failures: number;
  protocol: 'http/2' | 'http/1.1';
  error: string;
}

function isHttp2Failure(error: unknown): boolean {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 16) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const detail = item as { code?: unknown; cause?: unknown };
    if (typeof detail.code === 'string' && detail.code.startsWith('ERR_HTTP2_')) return true;
    pending.push(detail.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 8));
  }
  return false;
}

/** Prefer H2, replace failed pools, then fall back per origin until restart. */
export function createBackendFetch(onRecovery?: (recovery: TransportRecovery) => void): typeof fetch {
  const origins = new Map<string, OriginTransport>();
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
    const origin = url.origin;
    const startedAt = performance.now();
    let state = origins.get(origin);
    if (!state) {
      state = { dispatcher: new EnvHttpProxyAgent({ allowH2: true }), failures: [], http1: false };
      origins.set(origin, state);
    }
    const dispatcher = state.dispatcher;
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    try {
      return await fetch(input, { ...init, dispatcher } as RequestInit);
    } catch (error) {
      if (!state.http1 && state.dispatcher === dispatcher && !signal?.aborted && isHttp2Failure(error)) {
        const now = performance.now();
        // Successful heartbeats between failing uploads must not erase a
        // recurring fault. Only a quiet interval ages failures out.
        state.failures = state.failures.filter(at => now - at < HTTP2_FAILURE_WINDOW_MS);
        state.failures.push(now);
        state.http1 = state.failures.length >= HTTP2_FAILURE_LIMIT;
        state.dispatcher = new EnvHttpProxyAgent({ allowH2: !state.http1 });
        // Let in-flight requests finish under their own deadlines. Never replay
        // a POST here: the existing caller/outbox owns retries and deduplication.
        void dispatcher.close().catch(() => undefined);
        onRecovery?.({ origin, path: url.pathname,
          method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
          elapsedMs: Math.round(now - startedAt),
          ...(typeof init?.body === 'string' ? { requestBytes: Buffer.byteLength(init.body) } : {}),
          http2Failures: state.failures.length,
          protocol: state.http1 ? 'http/1.1' : 'http/2', error: transportErrorDetail(error) });
      }
      throw error;
    }
  };
}
