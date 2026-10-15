import { relayApiEndpoint, relayBackendPath } from "../lib/apiOrigin.ts";
import { type ResponseGuard, ResponseShapeIssue } from "./responseShape.ts";

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
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

export async function apiJson<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    versioned?: boolean;
    /** Checks the parsed body of a successful response before it is trusted as `T`. */
    guard?: ResponseGuard<T>;
  } = {},
): Promise<T> {
  const response = await fetch(options.versioned === false ? relayBackendPath(path) : relayApiEndpoint(path), {
    method: options.method ?? "GET",
    signal: options.signal,
    credentials: options.credentials ?? "include",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
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
    throw new RelayApiError(message, response.status, code);
  }
  if (!options.guard) return parsed as T;
  try {
    return options.guard(parsed);
  } catch (issue) {
    if (!(issue instanceof ResponseShapeIssue)) throw issue;
    const endpoint = `${options.method ?? "GET"} ${path}`;
    throw new RelayApiShapeError(endpoint, issue.field, issue.message, response.status);
  }
}
