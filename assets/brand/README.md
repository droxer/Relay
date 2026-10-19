# Relay Brand Assets

These are the repository-facing logo assets. The living color and typography
contract is maintained in [`docs/design-system.md`](../../docs/design-system.md);
do not duplicate its token table here.

## The mark

Two chevrons draw a handoff. The lead chevron is the ultramarine action
(`--action`, what a person does); the trailing chevron is the `--live` purple
(an agent carrying the work on). The colours are the palette's own tokens for
each register, never new hexes, and `web/tests/paletteTokens.test.ts` fails if
an icon drifts from them.

## Files

- `relay-logo.svg` is the primary wordmark for documentation and other
  standalone surfaces. Its ink and both chevrons follow the viewer's light or
  dark color scheme.
- `relay-mark.svg` is the light app-icon badge.
- `relay-logo-concept.png` is an early concept reference. Do not ship or embed
  it when an SVG is available.

The web app has delivery copies under `web/public/brand/` (byte-identical to
the two SVGs here), plus:

- `web/public/favicon.svg`, the dark browser-tab icon.
- `web/public/apple-touch-icon.png`, rendered at 180×180 from
  `relay-mark.svg`.

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
