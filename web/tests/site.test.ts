import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  PRIVATE_PATHS,
  SITE_SHARE_IMAGE,
  jsonLdScript,
  robotsPolicy,
  siteUrl,
  sitemapEntries,
  softwareJsonLd,
} from "../src/lib/site.js";

describe("siteUrl", () => {
  it("accepts a bare https origin, with or without a trailing slash", () => {
    assert.equal(siteUrl("https://get-relay.cc")?.href, "https://get-relay.cc/");
    assert.equal(siteUrl(" https://get-relay.cc/ ")?.href, "https://get-relay.cc/");
  });

  it("treats a missing, malformed, or non-origin value as undeclared", () => {
    for (const value of [undefined, "", "  ", "get-relay.cc", "ftp://get-relay.cc", "https://get-relay.cc/app", "https://get-relay.cc/?a=1", "https://u:p@get-relay.cc"]) {
      assert.equal(siteUrl(value), null, String(value));
    }
  });
});

describe("robotsPolicy", () => {
  it("keeps every crawler out of a build with no public address", () => {
    assert.deepEqual(robotsPolicy(null), { rules: [{ userAgent: "*", disallow: "/" }] });
  });

  it("admits the landing page, keeps the signed-in app out, and names the sitemap", () => {
    const policy = robotsPolicy(siteUrl("https://get-relay.cc"));
    assert.equal(policy.sitemap, "https://get-relay.cc/sitemap.xml");
    assert.equal(policy.rules[0].allow, "/");
    assert.deepEqual(policy.rules[0].disallow, [...PRIVATE_PATHS]);
    for (const path of ["/api/", "/login", "/threads", "/admin", "/settings"]) assert.ok(PRIVATE_PATHS.includes(path), path);
    assert.ok(!PRIVATE_PATHS.includes("/"));
    assert.ok(!PRIVATE_PATHS.includes("/waitlist"));
  });
});

describe("sitemapEntries", () => {
  it("lists only the landing page, and nothing without a public address", () => {
    assert.deepEqual(sitemapEntries(null), []);
    assert.deepEqual(sitemapEntries(siteUrl("https://get-relay.cc")).map((entry) => entry.url), ["https://get-relay.cc/"]);
  });
});

describe("softwareJsonLd", () => {
  it("describes Relay with absolute URLs on the declared origin", () => {
    const data = softwareJsonLd(siteUrl("https://get-relay.cc")!, "Agents at work.");
    assert.equal(data["@type"], "SoftwareApplication");
    assert.equal(data.url, "https://get-relay.cc/");
    assert.equal(data.image, `https://get-relay.cc${SITE_SHARE_IMAGE.url}`);
    assert.equal(data.description, "Agents at work.");
  });

  it("serializes so no value can close the script element", () => {
    const script = jsonLdScript({ description: "</script><script>alert(1)</script>" });
    assert.ok(!script.includes("<"));
    assert.deepEqual(JSON.parse(script), { description: "</script><script>alert(1)</script>" });
  });
});
