/** Bound for the response text a daemon error message keeps. */
export const ERROR_DETAIL_LIMIT = 200;

/**
 * Summarizes an error response body for logs. A proxy's error page (such as
 * Cloudflare's 502) is kilobytes of HTML that can carry the client's IP, so
 * HTML collapses to its title and any other body is bounded.
 */
export function errorBodyDetail(body: string): string {
  const trimmed = body.trim();
  if (/^<(!doctype|html|\?xml)/i.test(trimmed) || /<html[\s>]/i.test(trimmed)) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(trimmed)?.[1]?.replace(/\s+/g, " ").trim();
    return title ? `HTML error page: ${title.slice(0, ERROR_DETAIL_LIMIT)}` : "HTML error page";
  }
  const flat = trimmed.replace(/\s+/g, " ");
  return flat.length > ERROR_DETAIL_LIMIT ? `${flat.slice(0, ERROR_DETAIL_LIMIT)}…` : flat;
}

export async function responseErrorDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return errorBodyDetail(body);
}

const HTTP2_RESET_NAMES = [
  'NO_ERROR', 'PROTOCOL_ERROR', 'INTERNAL_ERROR', 'FLOW_CONTROL_ERROR',
  'SETTINGS_TIMEOUT', 'STREAM_CLOSED', 'FRAME_SIZE_ERROR', 'REFUSED_STREAM',
  'CANCEL', 'COMPRESSION_ERROR', 'CONNECT_ERROR', 'ENHANCE_YOUR_CALM',
  'INADEQUATE_SECURITY', 'HTTP_1_1_REQUIRED',
];

/** Keep useful Node transport codes, without dumping request/response objects or cause payloads. */
export function transportErrorDetail(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  const seen = new Set<unknown>([error]);
  const pending: unknown[] = error instanceof Error
    ? [error.cause, ...(error instanceof AggregateError ? error.errors : [])] : [];
  while (pending.length && seen.size < 16) {
    const item = pending.shift();
    if (!item || typeof item !== 'object' || seen.has(item)) continue;
    seen.add(item);
    const detail = item as { code?: unknown; http2ErrorCode?: unknown; syscall?: unknown; hostname?: unknown; cause?: unknown; errors?: unknown };
    const safe = [detail.code, detail.syscall, detail.hostname].filter((value): value is string =>
      typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,253}$/.test(value));
    if (typeof detail.http2ErrorCode === 'number' && Number.isInteger(detail.http2ErrorCode)
      && detail.http2ErrorCode >= 0 && detail.http2ErrorCode <= 0xffffffff) {
      safe.push(`http2ErrorCode=${detail.http2ErrorCode}`);
    }
    // Some Undici versions copy the error message but omit http2ErrorCode.
    // Extract only a known reset name, never arbitrary cause-message contents.
    if (detail.code === 'ERR_HTTP2_STREAM_ERROR' && item instanceof Error) {
      const reset = /^Stream closed with error code NGHTTP2_([A-Z0-9_]+)$/.exec(item.message)?.[1];
      if (reset && HTTP2_RESET_NAMES.includes(reset)) safe.push(`http2Reset=NGHTTP2_${reset}`);
    }
    if (safe.length) parts.push(safe.join(' '));
    pending.push(detail.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 8));
  }
  return [...new Set(parts)].join('; ').slice(0, 1000);
}
