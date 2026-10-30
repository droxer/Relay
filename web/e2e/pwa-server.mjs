// Serve the production export, including SPA deep links, without a backend.
// Bind only to loopback; no user or task state is created by these tests.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../out/", import.meta.url));
const mime = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:5021");
  if (url.pathname.startsWith("/api/")) {
    response.writeHead(401, { "Content-Type": "application/json" });
    response.end('{"error":"Sign in required"}');
    return;
  }
  const relative = extname(url.pathname) ? url.pathname : "/index.html";
  const filename = resolve(root, `.${relative}`);
  if (!filename.startsWith(root.endsWith(sep) ? root : root + sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(filename);
    response.writeHead(200, { "Content-Type": mime[extname(filename)] || "application/octet-stream", "Cache-Control": "no-cache" });
    response.end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(5021, "127.0.0.1");
