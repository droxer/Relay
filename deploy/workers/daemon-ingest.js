const reportPath = /^\/api\/v1\/daemon-nodes\/[^/]+\/(events|reports)$/;

export default {
  async fetch(request, env) {
    const incoming = new URL(request.url);
    if (incoming.host !== env.RELAY_API_HOST) return new Response(null, { status: 404 });
    if (request.method !== "POST" || !reportPath.test(incoming.pathname)) {
      return fetch(request);
    }

    const target = new URL(env.RELAY_INGEST_ORIGIN);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    const upstream = new Request(target, request);
    const headers = upstream.headers;
    headers.set("X-Relay-Edge", env.RELAY_INGEST_EDGE_SECRET);
    headers.delete("Cookie");
    headers.delete("Host");
    try {
      // Keep the request body byte-for-byte for its digest and keep the
      // credentials on this origin even if it responds with a redirect.
      return await fetch(new Request(upstream, { redirect: "manual" }));
    } catch {
      // Daemons replay failed requests. Sending the body to the API instead
      // would move the backlog back onto the service this route protects.
      return new Response(null, { status: 503, headers: { "Retry-After": "1", "Cache-Control": "no-store" } });
    }
  },
};
