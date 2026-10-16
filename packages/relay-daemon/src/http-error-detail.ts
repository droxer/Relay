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
