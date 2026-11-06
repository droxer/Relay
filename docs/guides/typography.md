# Web typography

Relay uses a compact application scale. Application body text and file lists
stay at 14px; standalone document previews use 16px for sustained reading.
Values below are
the result at the browser's default 16px font setting; the root is 87.5% and
the size tokens use rem so font preferences can scale them.

| Purpose | Size | Role |
| --- | --- | --- |
| Body, descriptions, instructions, errors | 14px | `--type-body` |
| File names and primary list names | 14px | `--type-name` |
| Controls, navigation, form labels | 14px | `--type-label` |
| Emphasized labels and list names | 14px | `--type-label-strong` |
| Short secondary data, timestamps, counts | 12px | `--type-meta`, `--type-body-sm` |
| Group labels and compact badges | 12px | `--type-micro`, `text-xs` |
| Section, panel, drawer, and dialog headings | 16px | `--type-heading`, `--type-title` |
| Page headings and key metrics | 22px | `--type-page`, `--type-number` |
| Display headings | 28px | `--type-display` |
| Document body | 16px | `--fs-document` |
| Document H1 / H2 / H3 | 28 / 22 / 18px | Document heading scale |
| Public hero headings | 22–36px | `--fs-hero` |

## Applying the scale

- Use a semantic `--type-*` role in surface CSS and its paired
  `--type-*-track` token. Shared primitives use the matching Tailwind utilities:
  `text-sm` for 14px controls and `text-xs` for 12px secondary data.
- Button and select sizes change geometry, not their text size. Do not shrink
  instructions, errors, menu items, search fields, or help text to fit a dense row.
- Keep workspace file names, sizes, and dates at 14px in both the project page
  and the Files drawer. Both use `WorkspaceFileList`.
- Document previews use 16px body text and 28/22/18px headings, with 16px for
  deeper levels. Headings use medium weight, with bold at H4 and italic at H6.
  Transcripts retain 14px body text and their compact heading scale.
- Small status badges, counts, table metadata, and mobile navigation captions
  can remain at 12px. These are short scanning aids rather than reading text.

## Reading and scaling

Body text uses 1.5 leading, controls 1.43, and captions 1.5. Document previews
use 1.75 leading and a 72ch reading measure. Chinese body and document text
use the existing looser language-specific leading and neutral tracking.

Touch text fields use `--fs-input-touch`: the greater of 16px and the relative
16px title token. This prevents small focused fields on iOS while allowing a
larger browser font preference to increase their text size. The composer draft
and its mention overlay share this token.

Shared text controls also have line-height-based minimum heights. Enlarging
the text can grow the control beyond its normal height instead of clipping it.

Text scaling should preserve content and functionality; see
[WCAG's Resize Text guidance](https://www.w3.org/WAI/WCAG21/Understanding/resize-text).
Check narrow layouts as well as desktop views when changing type roles.

## Font families and technical text

Keep the platform sans stack for UI and prose and the locally bundled JetBrains
Mono for technical strings. Code uses 14px, with the established 13px mono
size inside transcripts to balance that face's larger x-height. No additional
font downloads are needed.

The source of truth is `web/src/styles/tokens/palette.css` for sizes,
`tokens/roles.css` for roles, and `tokens/shadcn-bridge.css` for utility mappings.
`web/e2e/design-consistency.spec.ts` checks the rendered size relationships in
both themes on desktop and touch viewports, including enlarged font preferences.
