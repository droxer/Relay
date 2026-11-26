import { requestSessionRevalidation } from "../lib/sessionRevalidation.ts";
import { relayApiEndpoint, relayBackendPath } from "../lib/apiOrigin.ts";
import { type ResponseGuard, ResponseShapeIssue } from "./responseShape.ts";

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    /** The response's structured `detail`, for errors that carry more than a code. */
    public readonly detail?: unknown,
  ) {
    super(message);
  }
}

export const RESPONSE_SHAPE_ERROR_CODE = "invalid_response_shape";

/** A successful response whose body lacks something the UI dereferences.
 *  Raised at the boundary so the failure names the endpoint and the field,
 *  instead of surfacing later as a `TypeError` deep in a component. `status`
 *  is the response's own (2xx) status, so no 401/404 branch mistakes it. */
export class RelayApiShapeError extends RelayApiError {
  constructor(
    public readonly endpoint: string,
    public readonly field: string,
    detail: string,
    status: number,
  ) {
    super(`Relay returned an unexpected response from ${endpoint}: ${detail}.`, status, RESPONSE_SHAPE_ERROR_CODE);
    this.name = "RelayApiShapeError";
  }
}

function apiErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

function apiErrorCode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    return value.code;
  }
  return undefined;
}

/** Fetch from Relay and notify the auth owner of rejected cookie sessions.
 * A probe confirms expiry, so a resource rejection never signs out directly. */
export async function fetchWithSession(input: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(input, init);
  const path = new URL(input, "http://relay.local").pathname;
  const isAuthEntry = ["/auth/me", "/auth/login", "/auth/bootstrap"].some(suffix => path.endsWith(suffix));
  if (response.status === 401 && !isAuthEntry && init.credentials !== "omit"
    && !new Headers(init.headers).has("Authorization") && !init.signal?.aborted) {
    requestSessionRevalidation();
  }
  return response;
}

const MESSAGE_RETRY_DELAYS_MS = [500, 1_500];
const MESSAGE_ATTEMPT_TIMEOUT_MS = 15_000;
const RETRYABLE_MESSAGE_STATUSES = new Set([408, 500, 502, 503, 504]);
let messageDeliveryGeneration = 0;
const unconfirmedRejections = new WeakSet<RelayApiError>();

export function messageDefinitelyRejected(error: unknown): boolean {
  return error instanceof RelayApiError && error.status >= 400 && error.status < 500
    && error.status !== 408 && error.code !== "node_not_accepting_commands"
    && !unconfirmedRejections.has(error);
}

/** Pending messages belong to the Account that started them. */
export function cancelMessageDeliveryRetries(): void {
  messageDeliveryGeneration++;
}

export async function apiJson<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    versioned?: boolean;
    /** Only for messages the server deduplicates by an ID in the request body. */
    retryMessageDelivery?: boolean;
    /** Checks the parsed body of a successful response before it is trusted as `T`. */
    guard?: ResponseGuard<T>;
  } = {},
): Promise<T> {
  const url = options.versioned === false ? relayBackendPath(path) : relayApiEndpoint(path);
  const init: RequestInit = {
    method: options.method ?? "GET",
    signal: options.signal,
    credentials: options.credentials ?? "include",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  };
  const endpoint = `${init.method} ${path}`;
  if (!options.retryMessageDelivery) {
    return readApiResponse(await fetchWithSession(url, init), endpoint, options.guard);
  }

  const generation = messageDeliveryGeneration;
  const mayRetry = () => generation === messageDeliveryGeneration && !options.signal?.aborted;
  let deliveryUnconfirmed = false;
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(MESSAGE_ATTEMPT_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let response: Response | undefined;
    try {
      response = await fetchWithSession(url, { ...init, signal });
      return await readApiResponse(response, endpoint, options.guard);
    } catch (error) {
      deliveryUnconfirmed ||= !response || response.ok || RETRYABLE_MESSAGE_STATUSES.has(response.status);
      if (deliveryUnconfirmed && error instanceof RelayApiError) unconfirmedRejections.add(error);
      const delay = MESSAGE_RETRY_DELAYS_MS[attempt];
      // Even an unreadable error body can carry a definitive HTTP rejection.
      const transient = response && !response.ok
        ? RETRYABLE_MESSAGE_STATUSES.has(response.status)
          || (response.status === 409 && error instanceof RelayApiError && error.code === "node_not_accepting_commands")
        : timeout.aborted || error instanceof TypeError;
      if (delay === undefined || !transient || !mayRetry()) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
      if (!mayRetry()) throw error;
    }
  }
}

export type PrivateResponseCache<T> = { etag?: string; data?: T };

/** Use a simple credentialed GET even when Web and API have different origins. */
export function revisionPath(path: string, etag?: string, events?: string): string {
  if (!etag && !events) return path;
  const params = new URLSearchParams();
  if (etag) params.set("relayRevision", etag);
  if (events) params.set("relayEvents", events);
  return `${path}${path.includes("?") ? "&" : "?"}${params}`;
}

/** Revalidate an Account's in-memory copy without the browser's HTTP cache. */
export async function privateConditionalJson<T>(
  path: string, signal?: AbortSignal, responseCache?: PrivateResponseCache<T>, guard?: ResponseGuard<T>,
): Promise<T> {
  if (!responseCache) return apiJson(path, { signal, guard });
  const cached = responseCache.data;
  const response = await fetchWithSession(relayApiEndpoint(revisionPath(path, cached !== undefined ? responseCache.etag : undefined)), {
    signal,
    credentials: "include",
    cache: "no-store",
  });
  if (response.status === 304 && cached !== undefined) return cached;
  const data = await readApiResponse<T>(response, `GET ${path}`, guard);
  if (!signal?.aborted) {
    responseCache.data = data;
    responseCache.etag = response.headers.get("etag") ?? undefined;
  }
  return data;
}

/** Parses a Relay JSON response — or turns it into a `RelayApiError` — the way
    `apiJson` does, for a request that was started elsewhere (the bootstrap
    script's early `/auth/me` probe). `endpoint` names it in shape errors. */
export async function readApiResponse<T>(
  response: Response,
  endpoint: string,
  guard?: ResponseGuard<T>,
): Promise<T> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : undefined;
  } catch (error) {
    if (!response.ok) {
      throw new RelayApiError(text.trim() || response.statusText, response.status);
    }
    if (response.headers.get("content-type")?.includes("text/html") || text.trimStart().startsWith("<")) {
      throw new RelayApiError(
        "Relay returned an HTML response where this API expected JSON. Restart the Relay backend and web server, then try again.",
        response.status,
      );
    }
    throw error;
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" && "detail" in parsed ? parsed.detail : undefined;
    const error = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
    const message = apiErrorMessage(detail)
      ?? apiErrorMessage(error)
      ?? (text.trim() || response.statusText);
    const code = apiErrorCode(detail) ?? apiErrorCode(error);
    throw new RelayApiError(message, response.status, code, detail);
  }
  if (!guard) return parsed as T;
  try {
    return guard(parsed);
  } catch (issue) {
    if (!(issue instanceof ResponseShapeIssue)) throw issue;
    throw new RelayApiShapeError(endpoint, issue.field, issue.message, response.status);
  }
}
