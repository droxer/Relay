import type { MetadataRoute } from "next";

import { robotsPolicy, siteUrl } from "../lib/site";

// Written once into the static export as /robots.txt.
export const dynamic = "force-static";

export default function robots(): MetadataRoute.Robots {
  return robotsPolicy(siteUrl());
}
