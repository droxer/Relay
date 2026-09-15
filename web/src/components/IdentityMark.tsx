type IdentityMarkProps = {
  /** Which class of identity the mark stands for. */
  kind: "agent" | "team";
  /** `chip` (default) draws the filled glyph on the profile-image surface;
      `bare` draws the filled glyph alone, for empty states that supply their
      own frame; `outline` draws it hairline, for the nav rail — see the
      fill-vs-stroke note below. */
  variant?: "chip" | "bare" | "outline";
  /** Bare and outline marks size themselves; chip marks fill their profile box. */
  size?: number;
  /** Outline only: the stroke width to draw at, so the caller can hand the
      mark the same `ICON_STROKE` every other glyph in its row uses. Ignored
      by the filled variants. */
  strokeWidth?: number;
  className?: string;
};

/**
 * Relay's default profile image for an agent or an agent team.
 *
 * One primitive, two compositions — and the count is the entire difference.
 * The hexagon is a node: one of them is an agent, three of them clustered is
 * a team. The class reads off the silhouette alone at every size, and there
 * is no shape in the team mark that does not also appear in the agent mark.
 *
 * The team mark used to be a small org chart — a diamond over a stem over two
 * rectangles, four shapes and three of them unique to that one mark. At the
 * 16px chips in the composer and the mention popup the stem and the boxes
 * closed up into a blob. The cluster has no part thinner than the gaps
 * between its members, which is what makes it survive down there.
 *
 * The mark is deliberately identical for every agent. It says *what kind of
 * thing this is*, not which one; the display name beside it carries identity,
 * and an uploaded image replaces the mark entirely. It draws in currentColor
 * so it never introduces a hue — colour is reserved for live work.
 *
 * Two things keep it from reading as clip art. Every vertex is a quadratic
 * round-over — 2.6 units on the agent, 1.35 on each member — because a hard
 * miter is the tell of a plotted polygon, and the lucide set the rest of the
 * app draws joins its corners the same way. And the agent hexagon is r=8.8,
 * not the full 12 the grid allows: at full bleed one node carried more than
 * twice the ink of the three-node cluster beside it in the same list, so the
 * two marks disagreed about how heavy an identity is. At r=8.8 the agent
 * still runs about a fifth heavier, but close enough that the marks agree —
 * and pulling in from full bleed is what buys the margin inside the chip, so
 * the glyph never touches the hairline, at 16px or at 64.
 *
 * Filled, not stroked, *at chip sizes*. Strokes are the lighter, more current
 * idiom and were tried first, but a member hexagon is ~5px across in a 16px
 * chip; a 1px ring inside that is mud. Fill is what survives the smallest
 * chip, so fill is what the chip and bare variants use.
 *
 * The `outline` variant is the deliberate exception, and it exists for one
 * caller: the side-nav rail. There the mark is not a profile image standing
 * in for a face — it is a section glyph sitting in a row of eleven hairline
 * lucide siblings, and two solid blobs among them read as *permanently
 * active*, because a fill is exactly how the rail paints its selected state.
 * At the rail's 18px a member hexagon is ~6px with a 1.3px ring, which still
 * leaves ~3px of open interior — the chip's mud argument is a statement about
 * 16px chips with 12% padding, not about a bare 18px glyph. Nothing below
 * 16px may ask for it.
 */
const AGENT_PATHS = [
  "M9.75 4.5Q12 3.2 14.25 4.5L17.37 6.3Q19.62 7.6 19.62 10.2L19.62 13.8Q19.62 16.4 17.37 17.7L14.25 19.5Q12 20.8 9.75 19.5L6.63 17.7Q4.38 16.4 4.38 13.8L4.38 10.2Q4.38 7.6 6.63 6.3Z",
] as const;

const TEAM_PATHS = [
  "M10.83 3.62Q12 2.95 13.17 3.62L14.81 4.58Q15.98 5.25 15.98 6.6L15.98 8.5Q15.98 9.85 14.81 10.52L13.17 11.47Q12 12.15 10.83 11.47L9.19 10.53Q8.02 9.85 8.02 8.5L8.02 6.6Q8.02 5.25 9.19 4.58Z",
  "M6.03 12.53Q7.2 11.85 8.37 12.53L10.01 13.47Q11.18 14.15 11.18 15.5L11.18 17.4Q11.18 18.75 10.01 19.43L8.37 20.37Q7.2 21.05 6.03 20.37L4.39 19.43Q3.22 18.75 3.22 17.4L3.22 15.5Q3.22 14.15 4.39 13.47Z",
  "M15.63 12.53Q16.8 11.85 17.97 12.53L19.61 13.47Q20.78 14.15 20.78 15.5L20.78 17.4Q20.78 18.75 19.61 19.43L17.97 20.37Q16.8 21.05 15.63 20.37L13.99 19.43Q12.82 18.75 12.82 17.4L12.82 15.5Q12.82 14.15 13.99 13.47Z",
] as const;

export function IdentityMark({ kind, variant = "chip", size, strokeWidth, className }: IdentityMarkProps) {
  const paths = kind === "team" ? TEAM_PATHS : AGENT_PATHS;
  const outline = variant === "outline";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={variant === "chip" ? undefined : size}
      height={variant === "chip" ? undefined : size}
      data-variant={variant}
      className={`identity-mark${className ? ` ${className}` : ""}`}
      aria-hidden="true"
      focusable="false"
      fill={outline ? "none" : "currentColor"}
      stroke={outline ? "currentColor" : undefined}
      strokeWidth={outline ? strokeWidth : undefined}
      strokeLinejoin={outline ? "round" : undefined}
    >
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
