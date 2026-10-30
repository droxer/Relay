# Installing Relay

Relay can be installed as a standalone app on desktop and mobile. Use the
production site over HTTPS (localhost also works for testing).

- **Desktop Chrome / Edge:** use the browser's install app action in the address
  bar or menu.
- **Android:** use the browser's Install app / Add to Home screen action.
- **iPhone / iPad:** open Relay in Safari, tap Share, then Add to Home Screen
  and enable Open as Web App if offered.

Installed Relay opens `/threads`, uses the normal sign-in flow, and shares the
same responsive desktop and mobile views as the website. Installation does not
add a second account or change which computers execute agents.

## Offline behavior and updates

Relay needs a network connection to load threads, tasks, and other workspace
state. Its service worker caches only a generic, self-contained offline page,
never application HTML, API/SSE responses, profile images, or credentials.
An offline launch or hard navigation shows that page in English or Chinese,
using the saved language when available. Try again reloads the same deep link;
reconnecting also retries automatically. Already-open views retain their normal
network-error behavior.

Each production build emits `/sw.js` with the same build id as `/version.json`.
Activation deletes only older `relay-offline-*` caches. The worker can take over
without reloading open tabs because it caches no application shell or chunks;
the existing build-update notice continues to manage app updates.
Registration is disabled in development, unsupported browsers, and insecure
contexts. No push subscription or notification permission is requested.

## Development and verification

- `npm run build -w web`
- `npm run test:react -w web -- interaction-tests/pwa.test.tsx`
- `npm run test:pwa -w web` (requires the production export and Playwright Chromium)

The browser tests run against `web/out` in desktop and mobile contexts. They
check manifest discovery, Apple standalone metadata, worker control, cache
contents, offline deep links, retry after reconnection, and Chinese copy.
They do not automate native installation dialogs or physical iOS devices.

Icon assets derive from the existing favicon. Regenerate them after changing
that artwork with `node web/scripts/generate-pwa-icons.mjs` (requires Sharp,
already included in the Next.js dependency tree).

The manifest and worker are fixed-name files that must revalidate. FastAPI and
Caddy already apply this policy; Cloudflare Workers and Vercel have explicit
entries. All hosting modes serve the same static manifest, icons, offline page,
and generated worker. See [Next.js PWA guidance](https://nextjs.org/docs/app/guides/progressive-web-apps)
and [manifest icon purposes](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/icons).
