import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";

import {
  applyTheme,
  readDrawerWidth,
  readSidenavExpanded,
  readSidenavWidth,
  readTheme,
  readThreadListBesideSpace,
  readThreadListWidth,
  readThreadSpaceWidth,
  SUPPORTED_THEMES,
  writeDrawerWidth,
  writeSidenavExpanded,
  writeSidenavWidth,
  writeThreadListBesideSpace,
} from "../src/lib/appStorage.js";

describe("Relay web theme storage", () => {
  const storage = new Map<string, string>();
  let themeAttr: string | null = null;
  let themeMeta: HTMLMetaElement | null = null;

  beforeEach(() => {
    themeAttr = null;
    themeMeta = null;
    storage.clear();
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => { storage.clear(); },
      key: () => null,
      length: 0,
    } as Storage;
    globalThis.document = {
      documentElement: {
        setAttribute: (_name: string, value: string) => { themeAttr = value; },
        getAttribute: () => themeAttr,
        classList: { toggle: () => false },
      },
      head: {
        appendChild: (element: HTMLMetaElement) => {
          themeMeta = element;
          return element;
        },
      },
      createElement: () => {
        const attributes = new Map<string, string>();
        return {
          setAttribute: (name: string, value: string) => { attributes.set(name, value); },
          getAttribute: (name: string) => attributes.get(name) ?? null,
          removeAttribute: (name: string) => { attributes.delete(name); },
        } as unknown as HTMLMetaElement;
      },
      querySelector: () => themeMeta,
    } as unknown as Document;
    (globalThis as { window?: Window }).window = {
      getComputedStyle: () => ({
        getPropertyValue: (property: string) => {
          if (property !== "--surface-0") return "";
          return themeAttr === "dark" ? "rgb(16, 18, 20)" : "rgb(247, 248, 249)";
        },
      }) as CSSStyleDeclaration,
    } as unknown as Window;
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { document?: Document }).document;
    delete (globalThis as { window?: Window }).window;
    delete (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
  });

  it("defaults readTheme to system when storage is empty", () => {
    assert.equal(readTheme(), "system");
  });

  it("rejects unknown stored themes", () => {
    storage.set("relay-web.theme", "neon");
    assert.equal(readTheme(), "system");
  });

  it("migrates legacy high-contrast themes to system", () => {
    storage.set("relay-web.theme", "contrast");
    assert.equal(readTheme(), "system");
    assert.equal(storage.get("relay-web.theme"), "system");

    storage.set("relay-web.theme", "contrast-dark");
    assert.equal(readTheme(), "system");
    assert.equal(storage.get("relay-web.theme"), "system");
  });

  it("applyTheme resolves light and dark literally", () => {
    applyTheme("light");
    assert.equal(themeAttr, "light");
    applyTheme("dark");
    assert.equal(themeAttr, "dark");
  });

  it("exports all preference theme options", () => {
    assert.deepEqual([...SUPPORTED_THEMES], ["light", "dark", "system"]);
  });

  it("syncs browser chrome from the active CSS canvas", () => {
    applyTheme("light");
    assert.equal(themeMeta?.getAttribute("content"), "rgb(247, 248, 249)");

    applyTheme("dark");
    assert.equal(themeMeta?.getAttribute("content"), "rgb(16, 18, 20)");
  });

  it("applyTheme resolves system via matchMedia", () => {
    const matchMedia = (query: string) => ({
      matches: query.includes("dark"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    globalThis.matchMedia = matchMedia as unknown as typeof globalThis.matchMedia;
    window.matchMedia = matchMedia as unknown as Window["matchMedia"];
    applyTheme("system");
    assert.equal(themeAttr, "dark");
  });
});

describe("Relay web layout storage", () => {
  const storage = new Map<string, string>();

  const installStorage = (overrides: Partial<Storage> = {}) => {
    globalThis.localStorage = {
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, value); },
      removeItem: (key) => { storage.delete(key); },
      clear: () => { storage.clear(); },
      key: () => null,
      length: 0,
      ...overrides,
    } as Storage;
    (globalThis as { window?: Window }).window = {} as Window;
  };

  beforeEach(() => {
    storage.clear();
    installStorage();
  });

  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    delete (globalThis as { window?: Window }).window;
  });

  it("defaults the side nav to collapsed when nothing is stored", () => {
    assert.equal(readSidenavExpanded(), false);
  });

  it("round-trips the side nav expanded state", () => {
    writeSidenavExpanded(true);
    assert.equal(readSidenavExpanded(), true);
    writeSidenavExpanded(false);
    assert.equal(readSidenavExpanded(), false);
  });

  it("ignores unrecognised side nav values", () => {
    storage.set("relay-web.sidenavExpanded", "yes");
    assert.equal(readSidenavExpanded(), false);
  });

  it("defaults the thread list to hidden beside the space panel", () => {
    assert.equal(readThreadListBesideSpace(), false);
  });

  it("round-trips the thread list beside the space panel", () => {
    writeThreadListBesideSpace(true);
    assert.equal(readThreadListBesideSpace(), true);
    writeThreadListBesideSpace(false);
    assert.equal(readThreadListBesideSpace(), false);
  });

  it("round-trips panel widths and rejects junk", () => {
    writeSidenavWidth(260);
    assert.equal(readSidenavWidth(), 260);
    storage.set("relay-web.threadListWidth", "wide");
    assert.equal(readThreadListWidth(), null);
    storage.set("relay-web.threadSpaceWidth", "-4");
    assert.equal(readThreadSpaceWidth(), null);
  });

  it("remembers drawer widths per role and rejects junk", () => {
    assert.equal(readDrawerWidth("wide"), null);
    writeDrawerWidth("wide", 1200);
    assert.equal(readDrawerWidth("wide"), 1200);
    assert.equal(readDrawerWidth("form"), null);
    storage.set("relay-web.drawerWidth.wide", "wide");
    assert.equal(readDrawerWidth("wide"), null);
  });

  it("falls back to defaults when storage throws", () => {
    installStorage({
      getItem: () => { throw new Error("SecurityError"); },
      setItem: () => { throw new Error("QuotaExceededError"); },
    });
    assert.equal(readSidenavExpanded(), false);
    assert.equal(readSidenavWidth(), null);
    assert.equal(readThreadListBesideSpace(), false);
    assert.doesNotThrow(() => writeSidenavExpanded(true));
    assert.doesNotThrow(() => writeThreadListBesideSpace(true));
    assert.doesNotThrow(() => writeSidenavWidth(200));
  });

  it("is inert off the DOM", () => {
    delete (globalThis as { window?: Window }).window;
    assert.equal(readSidenavExpanded(), false);
    assert.doesNotThrow(() => writeSidenavExpanded(true));
    assert.equal(storage.size, 0);
  });
});
