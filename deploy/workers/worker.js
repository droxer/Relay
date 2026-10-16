// The relay-web Worker. Cloudflare serves every exported file straight from
// its static-asset store; this code runs only when no file matched. It draws
// the same line as web/Caddyfile: a pathname with a file suffix is an asset
// request, never a client route, so a missing script or image is a 404 rather
// than the app shell.
const ASSET_SUFFIX = /\.[A-Za-z0-9]+$/;

// The published install command names this origin, but the API serves the
// script: it pins its bundle and backend on the API origin, so send curl there
// (web/Caddyfile does the same). `/computer/install.sh` is the older path.
const INSTALLER_PATHS = new Set(["/install.sh", "/computer/install.sh"]);

// _headers is not applied to responses this code returns, so they carry its
// `/*` block themselves. deploy/tests/worker.mjs keeps the two identical.
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "base-uri 'self'; object-src 'none'; frame-ancestors 'none'",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
};

function withHeaders(response, cacheControl) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", cacheControl);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (INSTALLER_PATHS.has(url.pathname) && env.RELAY_API_ORIGIN) {
      const target = new URL(url.pathname + url.search, env.RELAY_API_ORIGIN);
      return withHeaders(Response.redirect(target.toString(), 302), "no-store");
    }
    if (ASSET_SUFFIX.test(url.pathname)) {
      const missing = new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain" } });
      return withHeaders(missing, "no-store");
    }
    // Everything else is a client route of the single-page app. Ask for "/",
    // not "/index.html": html_handling "auto-trailing-slash" answers the latter
    // with a 307 to "/", which would bounce every deep link to the home page.
    // The shell revalidates like every page, so a deploy is visible at once.
    const shell = await env.ASSETS.fetch(new Request(new URL("/", url), request));
    return withHeaders(shell, "no-cache");
  },
};
