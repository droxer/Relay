import { ICON } from "./icons";

type RelayMarkProps = {
  className?: string;
  size?: number;
  /** `ink` (default): register ink, for marks that sit inside working UI —
   *  transcript phase separators and generic empty states. `brand`: the
   *  baton handoff in colour, for the places Relay introduces itself. */
  tone?: "ink" | "brand";
};

export function RelayMark({ className, size = ICON.xl, tone = "ink" }: RelayMarkProps) {
  // Two interlocking 45-degree chamfered relay tracks passing a diagonal
  // negative-space baton across the center exchange zone. The brand tone is
  // the logo's one sanctioned static use of --live: the lead track is a person
  // handing work on (--brand-lead, burnished bronze) and the trailing track an
  // agent carrying it forward (--live, signal blue).
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
      <path
        d="M8 12 H36 L50 26 L42 34 L31 23 H8 Z"
        fill={isBrand ? "var(--brand-lead)" : "var(--ink-1)"}
      />
      <path
        d="M56 52 H28 L14 38 L22 30 L33 41 H56 Z"
        fill={isBrand ? "var(--live)" : "currentColor"}
        opacity={isBrand ? undefined : 0.45}
      />
    </svg>
  );
}
