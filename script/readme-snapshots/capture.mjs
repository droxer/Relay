#!/usr/bin/env node
/* Regenerates the README product snapshots in docs/images.

   The pages are the real static export (web/out) and the data is the demo
   set in fixtures.mjs, answered at the network layer — so a refresh needs no
   backend, no database, no daemon, and no agent credentials, and it can stage
   states a seeded backend cannot (a run in flight, a healthy fleet).

     npm run build -w web
     node script/readme-snapshots/capture.mjs

   --out <dir>    write somewhere other than docs/images
   --only <name>  capture one surface (repeatable)
   --draft        1x pixels, for a quick look while editing fixtures */

import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { FALLBACK, HERO_ID, routeBody } from "./fixtures.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const WEB_OUT = join(REPO_ROOT, "web/out");
const VIEWPORT = { width: 1440, height: 900 };
const LANGUAGES = [{ code: "en", suffix: "" }, { code: "zh-CN", suffix: "-zh-CN" }];
const READY_TIMEOUT_MS = 20_000;
/* Long enough for web fonts, avatars, and the enter transitions to settle. */
const SETTLE_MS = 900;
const BOUNDARY_TEXT = /This screen could not load|Page not found|页面未找到|无法加载/;
const MIME_TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json",
  ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".txt": "text/plain", ".ico": "image/x-icon",
};

/** Switches a project's issues from the list to the board, then parks the
 *  pointer so the toggle's tooltip is not in the picture. */
async function openBoard(page) {
  await page.locator(".backlog-view-btn").first().click();
  await page.waitForSelector(".backlog-task", { timeout: READY_TIMEOUT_MS });
  await page.mouse.move(0, 0);
}

/** One README snapshot: where it lives, what proves it rendered, and any
 *  interaction needed to reach the state worth showing. Tables and the
 *  board get the collapsed navigation rail so every column fits the frame. */
const SHOTS = [
  { name: "threads", path: `/threads/${HERO_ID}`, ready: ".transcript .msg" },
  { name: "issues", path: "/tasks", ready: ".backlog-filter-search-wrap", sidenav: false },
  { name: "routines", path: "/automations", ready: ".backlog-filter-search-wrap", sidenav: false },
  { name: "projects", path: "/projects/project_infra?tab=tasks", ready: ".backlog-view-btn", prepare: openBoard, sidenav: false },
  { name: "agents", path: "/agents/agent_aria", ready: ".record-band, .agent-profile" },
  { name: "teams", path: "/teams/team_platform_guild", ready: ".record-band, .workspace-page" },
  { name: "skills", path: "/settings/skills", ready: ".sec-nav" },
  { name: "computers", path: "/settings/computers", ready: ".sec-nav" },
  { name: "admin", path: "/admin/dashboard", ready: ".sec-nav" },
];

function parseOptions() {
  const { values } = parseArgs({
    options: {
      out: { type: "string", default: join(REPO_ROOT, "docs/images") },
      only: { type: "string", multiple: true, default: [] },
      draft: { type: "boolean", default: false },
    },
  });
  const unknown = values.only.filter((name) => !SHOTS.some((shot) => shot.name === name));
  if (unknown.length > 0) {
    throw new Error(`Unknown surface: ${unknown.join(", ")}. Known: ${SHOTS.map((shot) => shot.name).join(", ")}`);
  }
  return { outDir: resolve(values.out), only: values.only, draft: values.draft };
}

/** Serves web/out on a free port. The app owns its routing, so any path
 *  without an extension answers with the shell. */
async function serveExport() {
  try {
    await readFile(join(WEB_OUT, "index.html"));
  } catch {
    throw new Error(`No static export at ${WEB_OUT}. Run \`npm run build -w web\` first.`);
  }
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
      const file = resolve(WEB_OUT, `.${extname(pathname) ? pathname : "/index.html"}`);
      if (!file.startsWith(WEB_OUT + sep)) {
        response.writeHead(403).end();
        return;
      }
      const body = await readFile(file);
      response.writeHead(200, { "Content-Type": MIME_TYPES[extname(file)] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

/** Answers every API call from the fixtures; records the paths that fell
 *  through so a missing fixture is named instead of rendering as empty. */
async function mockApi(page, language, unmatched) {
  await page.route("**/api/v1/**", async (route) => {
    const url = new URL(route.request().url());
    if (/\/threads\/[^/]+\/events$/.test(url.pathname)) {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: ": connected\n\n" });
      return;
    }
    const body = route.request().method() === "GET" ? routeBody(url.pathname, url.searchParams, language) : undefined;
    if (body === undefined) unmatched.add(`${route.request().method()} ${url.pathname}`);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body ?? FALLBACK) });
  });
}

async function captureShot(browser, origin, shot, language, options) {
  const problems = [];
  const unmatched = new Set();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: options.draft ? 1 : 2,
    locale: language.code,
    colorScheme: "dark",
  });
  await context.addInitScript((expanded) => {
    localStorage.setItem("relay-web.sidenavExpanded", expanded);
  }, String(shot.sidenav !== false));
  const page = await context.newPage();
  page.on("pageerror", (error) => problems.push(`page error: ${error.message}`));
  await mockApi(page, language.code, unmatched);

  try {
    await page.goto(`${origin}${shot.path}`);
    await page.waitForSelector(shot.ready, { timeout: READY_TIMEOUT_MS });
    await shot.prepare?.(page);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(SETTLE_MS);
    if (await page.locator("html").getAttribute("data-theme") !== "dark") problems.push("dark theme was not applied");
    if (BOUNDARY_TEXT.test(await page.locator("body").innerText())) problems.push("rendered an error boundary");
    const file = join(options.outDir, `relay-${shot.name}${language.suffix}.png`);
    await page.screenshot({ path: file });
    return { file, problems, unmatched: [...unmatched] };
  } catch (error) {
    await page.screenshot({ path: join(options.outDir, `relay-${shot.name}${language.suffix}.failed.png`) }).catch(() => {});
    return { file: null, problems: [...problems, error.message.split("\n")[0]], unmatched: [...unmatched] };
  } finally {
    await context.close();
  }
}

async function main() {
  const options = parseOptions();
  await mkdir(options.outDir, { recursive: true });
  const { server, origin } = await serveExport();
  let browser;
  let failed = false;
  try {
    browser = await chromium.launch();
    const shots = options.only.length > 0 ? SHOTS.filter((shot) => options.only.includes(shot.name)) : SHOTS;
    for (const shot of shots) {
      for (const language of LANGUAGES) {
        const result = await captureShot(browser, origin, shot, language, options);
        const label = `${shot.name}${language.suffix}`;
        /* A path the fixtures did not answer rendered as an empty state, so
           the image exists but is not the picture it claims to be. */
        const problems = [...result.problems, ...result.unmatched.map((path) => `no fixture for ${path}`)];
        if (problems.length > 0) {
          failed = true;
          process.stderr.write(`FAILED ${label}: ${problems.join("; ")}\n`);
        } else {
          process.stdout.write(`wrote ${result.file}\n`);
        }
      }
    }
  } finally {
    await browser?.close();
    server.close();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
