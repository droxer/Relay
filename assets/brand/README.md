# Relay Brand Assets

These are the repository-facing logo assets. The living color and typography
contract is maintained in [`docs/design-system.md`](../../docs/design-system.md);
do not duplicate its token table here.

## The mark

Two chevrons draw a handoff. The lead chevron is the baton orange
(`--brand-lead`, a person handing work on); the trailing chevron is the
`--live` blue (an agent carrying the work on). Every copy draws one geometry:
`RelayMark`'s chevrons (64-unit box, stroke 7). The badges scale them by 0.7
about the centre, so the pair sits on the badge's centre, with a 6.5 stroke
that holds up at 16px. The wordmark draws them unscaled beside the name in
the `--font-sans` stack at weight 500, in `--ink-1`. The colours are the palette's own tokens for
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

- `web/public/favicon.svg`, the browser-tab icon: dark by default, white
  with the `--line-1` hairline when the viewer's scheme is light. Once the
  signed-in app mounts, `useLiveFavicon` redraws it (`faviconState.ts`) in
  the app's own painted theme, so a theme switch repaints the tab.
- `web/public/apple-touch-icon.png`, rendered at 180×180 from
  `relay-mark.svg` cropped to its badge, as an opaque square without the
  hairline (iOS applies its own mask and paints transparency black).
- `web/public/favicon.ico`, 16/32/48px PNGs rendered from `favicon.svg`.

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
