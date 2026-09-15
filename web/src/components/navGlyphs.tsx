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
 *   - Corner round-overs of 2.6 on the large shapes and 1.2 on the small
 *     ones — the same 2.6/1.35 relationship the identity marks use, which is
 *     what keeps a hand-drawn shape from reading as a plotted polygon.
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
 * A computer: a package with a die in it, and two legs.
 *
 * `Cpu` is the accurate noun and was kept through two passes for that reason,
 * but it spends eight pin strokes plus an inner square on a 18px glyph and
 * resolves to hatching — it was measurably the densest mark in the column.
 * Two pins carry the same "this is silicon, not a screen" reading, and they
 * are what stops the outline collapsing into the generic rounded square that
 * a bare package would be. The die is a rounded rect rather than a hard one
 * so the glyph's two shapes agree about corners.
 *
 * Sized against its members, not just its siblings: a computer in the list
 * below this destination is drawn by its ownership glyph (`Cloud`, `Laptop`,
 * `CircleDashed`), and none of those is a chip — so section and member still
 * never collapse into the same picture.
 */
export const ChipGlyph = relayGlyph(
  <>
    <path d="M7.4 5.2h9.2a2.6 2.6 0 0 1 2.6 2.6v8.4a2.6 2.6 0 0 1-2.6 2.6H7.4a2.6 2.6 0 0 1-2.6-2.6V7.8a2.6 2.6 0 0 1 2.6-2.6Z" />
    <path d="M10.6 9.9h2.8a1.2 1.2 0 0 1 1.2 1.2v1.8a1.2 1.2 0 0 1-1.2 1.2h-2.8a1.2 1.2 0 0 1-1.2-1.2v-1.8a1.2 1.2 0 0 1 1.2-1.2Z" />
    <path d="M12 2.6v2.6" />
    <path d="M12 18.8v2.6" />
  </>,
  "ChipGlyph",
);
