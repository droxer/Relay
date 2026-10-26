import { ICON } from "./icons";

type RelayMarkProps = {
  className?: string;
  size?: number;
  /** `ink` (default): register ink, for marks that sit inside working UI —
   *  transcript phase separators and generic empty states. `brand`: the
   *  handoff in colour, for the places Relay introduces itself. */
  tone?: "ink" | "brand";
};

export function RelayMark({ className, size = ICON.xl, tone = "ink" }: RelayMarkProps) {
  // The brand tone is the logo's one sanctioned static use of --live, the
  // same carve-out the app icons take: the lead chevron is a person handing
  // work on (--brand-lead), the trailing chevron an agent carrying it on
  // (--live). The app icons and the wordmark draw this same geometry.
  // Everywhere else blue still means work in progress and always moves.
  const isBrand = tone === "brand";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
    >
      <g
        fill="none"
        strokeWidth="7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 14 L32 32 L12 50" stroke={isBrand ? "var(--brand-lead)" : "var(--ink-1)"} />
        <path
          d="M32 14 L52 32 L32 50"
          stroke={isBrand ? "var(--live)" : "currentColor"}
          opacity={isBrand ? undefined : 0.45}
        />
      </g>
    </svg>
  );
}
