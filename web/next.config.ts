import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

const backendUrl = process.env.RELAY_BACKEND_URL ?? process.env.RELAY_DAEMON_URL ?? "http://127.0.0.1:8790";

// The app is a client-routed SPA rendered from a single entry page, so every
// deep link has to resolve back to it. Dev and the hosted build need the same
// list; only their mechanism differs (dev `fallback` rewrites vs. a hosted
// rewrite that runs after static files are matched).
const CLIENT_ROUTES = [
  "/login",
  "/threads",
  "/threads/:path*",
  "/backlog",
  "/routines",
  "/routines/:path*",
  "/agents",
  "/agents/:path*",
  "/teams",
  "/teams/:path*",
  "/settings",
  "/settings/:path*",
  "/projects",
  "/projects/:path*",
  "/channels",
  "/admin",
  "/admin/:path*",
] as const;

const spaFallbackRewrites = () => CLIENT_ROUTES.map((source) => ({ source, destination: "/" }));

const backendProxyRewrites = () => [
  { source: "/api/:path*", destination: `${backendUrl}/api/:path*` },
  { source: "/profile-images/:path*", destination: `${backendUrl}/profile-images/:path*` },
];

/**
 * Relay ships the web UI two ways, and the build has to differ between them:
 *
 * - **Served by the backend** (default): a static export written to `web/out`,
 *   which the backend serves at `/`. Everything is same-origin.
 * - **Hosted separately** (`RELAY_WEB_HOST=proxy`, e.g. Vercel): a Node build
 *   whose rewrites proxy `/api` and `/profile-images` to the backend, keeping
 *   the browser same-origin so the session cookie needs no cross-site handling.
 *
 * A separately hosted build that instead calls the backend directly
 * (`NEXT_PUBLIC_RELAY_API_ORIGIN` set, backend CORS configured) needs no
 * proxying and stays on the static export.
 */
const nextConfig = (phase: string): NextConfig => {
  const isDev = phase === PHASE_DEVELOPMENT_SERVER;
  const proxyToBackend = !isDev && process.env.RELAY_WEB_HOST === "proxy";

  if (isDev) {
    return {
      // Suppress the Next dev-mode indicator badge: it renders fixed at the
      // bottom-left corner and overlaps the SideNav "Settings" control. It
      // never ships, so hiding it only affects local dev ergonomics.
      devIndicators: false,
      async rewrites() {
        return { beforeFiles: backendProxyRewrites(), fallback: spaFallbackRewrites() };
      },
    };
  }

  if (proxyToBackend) {
    return {
      async rewrites() {
        return { beforeFiles: backendProxyRewrites(), fallback: spaFallbackRewrites() };
      },
    };
  }

  return { output: "export" as const };
};

export default nextConfig;
