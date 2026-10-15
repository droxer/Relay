import type { MetadataRoute } from "next";

import { siteUrl, sitemapEntries } from "../lib/site";

// Written once into the static export as /sitemap.xml.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapEntries(siteUrl());
}
