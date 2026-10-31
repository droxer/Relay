/* What search engines and link unfurlers are told about the web UI. Kept apart
   from the Next metadata files so the rules can be checked without a build.

   Only a build that declares its public address is indexable. The same export
   also runs inside private installs (served by the backend, or on a team's own
   host), and those must never invite a crawler or name someone else's domain
   as canonical — so without NEXT_PUBLIC_RELAY_SITE_URL every rule below falls
   back to "keep out". */

import { RELAY_GITHUB_URL } from "./landing.ts";

export const SITE_NAME = "Relay";

/** The social preview image: the paper card rendered by
    script/og-card/render.mjs at the 1200×630 size unfurlers crop to. */
export const SITE_SHARE_IMAGE = { url: "/og.png", width: 1200, height: 630 } as const;

/** Client routes behind sign-in. They serve the same app shell as "/", so a
    crawler would only find a login form there; keep them out of the index. */
export const PRIVATE_PATHS: readonly string[] = [
  "/api/",
  "/login",
  "/join",
  "/forgot-password",
  "/reset-password",
  "/home",
  "/threads",
  "/tasks",
  "/issues",
  "/backlog",
  "/automations",
  "/routines",
  "/agents",
  "/teams",
  "/settings",
  "/projects",
  "/channels",
  "/admin",
  "/computers",
  "/computer",
  "/skills",
];

/**
 * The public origin of this build (e.g. `https://get-relay.cc`), or null when
 * the build does not declare one. Only a bare http(s) origin counts; a path,
 * query, or anything unparsable is treated as undeclared rather than emitted
 * into canonical links.
 */
export function siteUrl(configured: string | undefined = process.env.NEXT_PUBLIC_RELAY_SITE_URL): URL | null {
  const value = configured?.trim().replace(/\/+$/, "");
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) return null;
  return url;
}

export interface RobotsRule {
  userAgent: string;
  allow?: string;
  disallow: string | string[];
}

export interface RobotsPolicy {
  rules: RobotsRule[];
  sitemap?: string;
}

/** robots.txt: the landing and waitlist pages are public; everything else is
    the signed-in app. A build with no public address disallows everything. */
export function robotsPolicy(site: URL | null): RobotsPolicy {
  if (!site) return { rules: [{ userAgent: "*", disallow: "/" }] };
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...PRIVATE_PATHS] }],
    sitemap: new URL("/sitemap.xml", site).href,
  };
}

export interface SitemapEntry {
  url: string;
  changeFrequency: "weekly" | "monthly";
  priority: number;
}

/** sitemap.xml: the page a signed-out visitor can actually read. The waitlist
    is switched on at runtime (`GET /auth/status`), so a static sitemap cannot
    know whether it exists and leaves it out. */
export function sitemapEntries(site: URL | null): SitemapEntry[] {
  if (!site) return [];
  return [{ url: new URL("/", site).href, changeFrequency: "weekly", priority: 1 }];
}

/** schema.org description of the product, embedded as JSON-LD. */
export function softwareJsonLd(site: URL, description: string): Record<string, unknown> {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    description,
    url: site.href,
    image: new URL(SITE_SHARE_IMAGE.url, site).href,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "macOS, Linux, Windows",
    license: "https://opensource.org/license/mit",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    sameAs: [RELAY_GITHUB_URL],
  };
}

/** Serializes JSON-LD for an inline script: "<" is escaped so no string in it
    can close the element early. */
export function jsonLdScript(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}
