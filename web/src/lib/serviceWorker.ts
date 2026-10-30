/** Emitted as /sw.js by a static route, so every deployment changes its bytes.
 * Only a generic offline document is cached. Auth, API/SSE, media, and the
 * application shell always use the network and retain their existing policy.
 */
export function serviceWorkerSource(buildId: string): string {
  return `
const CACHE_PREFIX = "relay-offline-";
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(buildId)};
const OFFLINE_URL = "/offline.html";
const PAGE_ROOTS = new Set([
  "", "login", "waitlist", "join", "forgot-password", "reset-password",
  "threads", "tasks", "issues", "backlog", "automations", "routines",
  "agents", "teams", "computers", "computer", "skills", "settings",
  "projects", "channels", "admin"
]);

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.add(new Request(new URL(OFFLINE_URL, self.location.origin), {
      cache: "reload", credentials: "omit"
    }));
    // No app shell or chunks are cached, so taking over cannot mix builds.
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || request.mode !== "navigate" ||
      url.origin !== self.location.origin || !PAGE_ROOTS.has(url.pathname.split("/")[1]) ||
      /\\.[^/]+$/.test(url.pathname)) return;
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cache = await caches.open(CACHE_NAME);
      return await cache.match(OFFLINE_URL) || new Response("Relay is offline. Reconnect and reload.", {
        status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" }
      });
    }
  })());
});
`;
}
