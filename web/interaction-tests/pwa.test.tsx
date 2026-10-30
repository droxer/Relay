import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { registerPwaServiceWorker } from "../src/lib/pwa";
import { serviceWorkerSource } from "../src/lib/serviceWorker";

function worker(buildId = "build-one") {
  const handlers: Record<string, (event: any) => void> = {};
  const cache = { add: vi.fn().mockResolvedValue(undefined), match: vi.fn().mockResolvedValue(new Response("offline")) };
  const caches = {
    open: vi.fn().mockResolvedValue(cache),
    keys: vi.fn().mockResolvedValue(["relay-offline-old", "another-app"]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const self = {
    location: { origin: "https://relay.test" },
    addEventListener: (name: string, handler: (event: any) => void) => { handlers[name] = handler; },
    skipWaiting: vi.fn().mockResolvedValue(undefined),
    clients: { claim: vi.fn().mockResolvedValue(undefined) },
  };
  const fetch = vi.fn().mockResolvedValue(new Response("online"));
  runInNewContext(serviceWorkerSource(buildId), { self, caches, fetch, URL, Request, Response });
  return { handlers, cache, caches, self, fetch };
}

function navigate(w: ReturnType<typeof worker>, path: string, overrides = {}) {
  const respondWith = vi.fn();
  w.handlers.fetch({ request: { url: `https://relay.test${path}`, method: "GET", mode: "navigate", ...overrides }, respondWith });
  return respondWith;
}

describe("PWA worker", () => {
  it("precaches only the generic offline page, with a cache per build", async () => {
    const w = worker();
    const waitUntil = vi.fn();
    w.handlers.install({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(w.caches.open).toHaveBeenCalledWith("relay-offline-build-one");
    expect(w.cache.add).toHaveBeenCalledTimes(1);
    expect(w.cache.add.mock.calls[0][0].url).toBe("https://relay.test/offline.html");
    expect(w.self.skipWaiting).toHaveBeenCalled();
    expect(serviceWorkerSource("build-two")).not.toBe(serviceWorkerSource("build-one"));
  });

  it("removes only Relay's old offline caches and takes control", async () => {
    const w = worker();
    w.caches.keys.mockResolvedValue(["relay-offline-old", "relay-offline-build-one", "another-app"]);
    const waitUntil = vi.fn();
    w.handlers.activate({ waitUntil });
    await waitUntil.mock.calls[0][0];
    expect(w.caches.delete.mock.calls).toEqual([["relay-offline-old"]]);
    expect(w.self.clients.claim).toHaveBeenCalled();
  });

  it.each(["/", "/threads/one", "/tasks/t-1", "/computers", "/login?returnTo=%2Fthreads"])("uses the network then the offline page for %s", async path => {
    const w = worker();
    let response = navigate(w, path);
    expect(await (await response.mock.calls[0][0]).text()).toBe("online");
    w.fetch.mockRejectedValue(new TypeError("offline"));
    response = navigate(w, path);
    expect(await (await response.mock.calls[0][0]).text()).toBe("offline");
    expect(w.cache.match).toHaveBeenCalledWith("/offline.html");
  });

  it("keeps HTTP failures visible instead of masking them as offline", async () => {
    const w = worker();
    w.fetch.mockResolvedValue(new Response("unavailable", { status: 503 }));
    const response = navigate(w, "/threads");
    expect((await response.mock.calls[0][0]).status).toBe(503);
    expect(w.cache.match).not.toHaveBeenCalled();
  });

  it("has a response even if the offline cache was evicted", async () => {
    const w = worker();
    w.fetch.mockRejectedValue(new TypeError("offline"));
    w.cache.match.mockResolvedValue(undefined);
    const response = navigate(w, "/threads");
    expect((await response.mock.calls[0][0]).status).toBe(503);
  });

  it.each([
    ["/api/v1/auth/me", {}], ["/profile-images/users/one", {}],
    ["/install.sh", {}], ["/computer/daemon-a.tar.gz", {}],
    ["/_next/static/app.js", {}], ["/version.json", {}],
    ["/unknown", {}], ["/threads/missing.js", {}],
    ["/threads", { method: "POST" }], ["/threads", { mode: "cors" }],
    ["/threads", { url: "https://other.test/threads" }],
  ])("does not intercept sensitive or non-navigation requests: %s %o", (path, overrides) => {
    expect(navigate(worker(), path, overrides)).not.toHaveBeenCalled();
  });
});

describe("PWA registration", () => {
  it("registers at the origin root without using the HTTP cache", async () => {
    const register = vi.fn().mockResolvedValue({});
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    await registerPwaServiceWorker(true);
    expect(register).toHaveBeenCalledWith("/sw.js", { scope: "/", updateViaCache: "none" });
    await registerPwaServiceWorker(false);
    expect(register).toHaveBeenCalledTimes(1);
  });

  it("leaves unsupported and insecure browsers usable", async () => {
    const register = vi.fn();
    vi.stubGlobal("isSecureContext", false);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });
    await registerPwaServiceWorker(true);
    expect(register).not.toHaveBeenCalled();
    delete (navigator as any).serviceWorker;
    vi.stubGlobal("isSecureContext", true);
    await expect(registerPwaServiceWorker(true)).resolves.toBeUndefined();
  });

  it("does not break the app if registration fails", async () => {
    vi.stubGlobal("isSecureContext", true);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: vi.fn().mockRejectedValue(new Error("blocked")) } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(registerPwaServiceWorker(true)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});

it("provides desktop, mobile and maskable install icons", () => {
  const manifest = JSON.parse(readFileSync(`${process.cwd()}/public/manifest.webmanifest`, "utf8"));
  expect(manifest).toMatchObject({ id: "/", name: "Relay", short_name: "Relay", start_url: "/threads", scope: "/", display: "standalone" });
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: "192x192", purpose: "any" }),
    expect.objectContaining({ sizes: "512x512", purpose: "any" }),
    expect.objectContaining({ sizes: "512x512", purpose: "maskable" }),
  ]));
  for (const icon of manifest.icons) {
    const png = readFileSync(`${process.cwd()}/public${icon.src}`);
    const size = Number(icon.sizes.split("x")[0]);
    expect(png.readUInt32BE(16)).toBe(size);
    expect(png.readUInt32BE(20)).toBe(size);
  }
});
