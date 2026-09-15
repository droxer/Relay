import { forwardRef, type ReactNode, type SVGProps } from "react";

/**
 * Glyphs Relay draws itself, for the two rail destinations where no lucide
 * picture was both accurate and quiet enough.
 *
 * The rail is nine destinations read as one vertical column, and the binding
 * constraint there is not semantics — it is that no two of them may share a
 * SILHOUETTE. A first pass drew Projects, Computer and Control panel all as
 * "a rounded square with something inside"; each was defensible alone and
 * together they were three interchangeable boxes at 18px, which is worse than
 * the mixed set they replaced. So only the glyphs that earn a bespoke drawing
 * get one, and each earns it by occupying an outline nothing else in the rail
 * does.
 *
 * Both are drawn to the same rules as `IdentityMark`, which is the other
 * hand-drawn mark in this rail:
 *
 *   - 24×24 grid, content inside 3.8–20.2, so the glyph fills the same
 *     optical box as the lucide siblings either side of it (~20 units).
 *   - Corner round-overs on a roughly 2:1 ratio between a glyph's outer shape
 *     and anything nested inside it (the chip is 3 / 1.5) — the same
 *     relationship the identity marks use at 2.6 / 1.35, and what keeps a
 *     hand-drawn shape from reading as a plotted polygon.
 *   - Round caps and joins, and the caller's stroke width (`icons.tsx` wraps
 *     these in `withStandardStroke` exactly as it wraps a lucide icon, so
 *     they take ICON_STROKE by default and the hero tier can still override).
 *   - Nothing thinner than 2.6 units of open space, so no interior detail
 *     closes up at the 16px the mobile More menu draws them at.
 *
 * They deliberately do NOT import lucide-react: these are the pictures lucide
 * did not have. The prop shape mirrors it so `withStandardStroke` cannot tell
 * the difference.
 */
export type RelayGlyphProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  size?: number | string;
};

function relayGlyph(paths: ReactNode, displayName: string) {
  const Glyph = forwardRef<SVGSVGElement, RelayGlyphProps>(
    ({ size = 24, strokeWidth = 2, ...rest }, ref) => (
      <svg
        ref={ref}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        focusable="false"
        {...rest}
      >
        {paths}
      </svg>
    ),
  );
  Glyph.displayName = displayName;
  return Glyph;
}

/**
 * The backlog: a queue of tasks, one of them done.
 *
 * Every off-the-shelf task list spends its ink on checkbox chrome — lucide's
 * `ListTodo` leads with a filled-weight square, `ListChecks` repeats the tick
 * twice — and at 18px that chrome is the loudest thing in the rail while
 * saying the least. Here the tick is the only mark that is not a plain rule,
 * so "a list, with progress in it" arrives in one shape instead of five, and
 * the three rules underneath keep the glyph horizontally open where its
 * neighbours (a bubble, a stack, a hexagon) are all closed forms.
 */
export const TaskListGlyph = relayGlyph(
  <>
    <path d="m3.8 6.5 2 2 3.2-3.6" />
    <path d="M11.6 7h8.6" />
    <path d="M3.8 12.6h16.4" />
    <path d="M3.8 17.8h16.4" />
  </>,
  "TaskListGlyph",
);

/**
 * A computer: a package with a die in it, and four legs.
 *
 * `Cpu` is the accurate noun and was kept through two passes for that reason,
 * but it spends eight pin strokes plus an inner square on a 18px glyph and
 * resolves to hatching — it was measurably the densest mark in the column.
 * Four pins carry the same "this is silicon, not a screen" reading at a
 * quarter of the ink, and they are what stops the outline collapsing into the
 * generic rounded square that a bare package would be. The die is a rounded
 * rect rather than a hard one so the glyph's two shapes agree about corners.
 *
 * The body is 16 units wide so the glyph FILLS the optical box rather than
 * floating inside it. A first cut drew it at 14.4 against lucide's ~20: no
 * one can see that at the rail's 18px, and it is unmistakable at the 40px
 * `ICON.hero` this glyph reaches through `AdminNode` in the computers and
 * fleet empty states, where it sat small and thin in the middle of its slot.
 * Check a bespoke glyph inside a drawn 40px guide box, not only in the rail.
 *
 * Sized against its members, not just its siblings: a computer in the list
 * below this destination is drawn by its ownership glyph (`Cloud`, `Laptop`,
 * `CircleDashed`), and none of those is a chip — so section and member still
 * never collapse into the same picture.
 */
export const ChipGlyph = relayGlyph(
  <>
    <path d="M7 4.6h10a3 3 0 0 1 3 3v8.8a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V7.6a3 3 0 0 1 3-3Z" />
    <path d="M10.8 9.3h2.4a1.5 1.5 0 0 1 1.5 1.5v2.4a1.5 1.5 0 0 1-1.5 1.5h-2.4a1.5 1.5 0 0 1-1.5-1.5v-2.4a1.5 1.5 0 0 1 1.5-1.5Z" />
    <path d="M9.2 2.6v2" />
    <path d="M14.8 2.6v2" />
    <path d="M9.2 19.4v2" />
    <path d="M14.8 19.4v2" />
  </>,
  "ChipGlyph",
);
