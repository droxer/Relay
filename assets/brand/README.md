# Relay Brand Assets

These are the repository-facing logo assets. The living color and typography
contract is maintained in [`docs/design-system.md`](../../docs/design-system.md);
do not duplicate its token table here.

## The mark

Two chevrons draw a handoff. The lead chevron is the baton orange
(`--brand-lead`, a person handing work on); the trailing chevron is the
`--live` blue (an agent carrying the work on). Application chrome and
wordmarks use `RelayMark`'s chevrons (64-unit box, stroke 7). Small launcher
badges use the bolder, more separated paths in
`web/public/favicon.svg` (stroke 12) to stay readable at 16px. The wordmark uses
the sans stack at weight 500 and follows the viewer's color scheme. Launcher
badges use a fixed charcoal canvas with orange and blue from the dark palette,
so they remain recognizable independently of the surrounding theme.

## Files

- `relay-logo.svg` is the primary wordmark for documentation and other
  standalone surfaces. Its ink and both chevrons follow the viewer's light or
  dark color scheme.
- `relay-mark.svg` is the fixed charcoal app-icon badge, generated from the favicon.
- `relay-logo-concept.png` is an early concept reference. Do not ship or embed
  it when an SVG is available.

The web app has delivery copies under `web/public/brand/` (byte-identical to
the two SVGs here), plus:

- `web/public/favicon.svg`, the browser-tab icon, uses a charcoal tile with a
  subtle hairline. The signed-in app redraws it through `faviconState.ts`:
  orange and blue chevrons when idle, a blue trailing chevron while running, and an
  orange lead chevron when input is needed. Browser and app themes are independent.
- `web/public/apple-touch-icon.png`, an opaque 180×180 square with the same
  colors and mark. iOS supplies its own rounded mask.
- `web/public/icons/icon-{192,512}.png`, the PWA install and shortcut icons.
- `web/public/icons/icon-maskable-512.png`, a full-bleed opaque square with
  the chevrons inside Android's central 80% safe circle, without an inset tile.
- `web/public/favicon.ico`, 16/32/48px PNGs rendered from `favicon.svg`.

Regenerate all launcher assets and both `relay-mark.svg` delivery copies with
`node web/scripts/generate-pwa-icons.mjs`. Edit `favicon.svg` first; keep the
runtime tile, paths and colors in `faviconState.ts` in sync.

## Usage

- Use the wordmark in readmes, documentation, and wide product headers.
- Use an app-icon badge for favicons, touch icons, avatars, and compact launch
  surfaces.
- Use the in-app `RelayMark` component for themed application chrome instead
  of embedding one of these fixed-register SVGs: `tone="brand"` where Relay
  introduces itself, the default ink tone inside working UI.
- Preserve each SVG's `viewBox`, rounded strokes, and
  `shape-rendering="geometricPrecision"` setting.
- SVG comments must not contain `--` (it is invalid XML and breaks
  rasterizers), so refer to tokens by name without the leading dashes.

When the identity changes, update the design system first, then review both
asset trees, the favicon, and the touch icon together.
