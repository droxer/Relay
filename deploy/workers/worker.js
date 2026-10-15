// The relay-web Worker. Cloudflare serves every exported file straight from
// its static-asset store; this code runs only when no file matched. It draws
// the same line as web/Caddyfile: a pathname with a file suffix is an asset
// request, never a client route, so a missing script or image is a 404 rather
// than the app shell.
const ASSET_SUFFIX = /\.[A-Za-z0-9]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (ASSET_SUFFIX.test(url.pathname)) {
      return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
    }
    // Everything else is a client route of the single-page app.
    return env.ASSETS.fetch(new Request(new URL("/index.html", url), request));
  },
};
