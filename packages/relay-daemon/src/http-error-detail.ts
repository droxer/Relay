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
    const detail = item as { code?: unknown; syscall?: unknown; hostname?: unknown; cause?: unknown; errors?: unknown };
    const safe = [detail.code, detail.syscall, detail.hostname].filter((value): value is string =>
      typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,253}$/.test(value));
    if (safe.length) parts.push(safe.join(' '));
    pending.push(detail.cause);
    if (item instanceof AggregateError) pending.push(...item.errors.slice(0, 8));
  }
  return [...new Set(parts)].join('; ').slice(0, 1000);
}
