import { serviceWorkerSource } from "../../lib/serviceWorker";

// Matches version.json: Next emits the worker into web/out for static hosts.
export const dynamic = "force-static";

export function GET(): Response {
  return new Response(serviceWorkerSource(process.env.NEXT_PUBLIC_RELAY_BUILD_ID ?? "dev"), {
    headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-cache" },
  });
}
