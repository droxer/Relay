import { ICON } from "./icons";

type RelayMarkProps = {
  className?: string;
  size?: number;
  /** `ink` (default): register ink, for marks that sit inside working UI —
   *  transcript phase separators and generic empty states. `brand`: monochrome
   *  tracks bridged by the burnished-bronze relay baton, for the places Relay
   *  introduces itself. */
  tone?: "ink" | "brand";
};

export function RelayMark({ className, size = ICON.xl, tone = "ink" }: RelayMarkProps) {
  // Swiss Baton Cascade: three precision sheared tracks with the staggered
  // center relay baton highlighted in burnished bronze (--brand-lead).
  const isBrand = tone === "brand";
  const trackFill = isBrand ? "var(--ink-1)" : "currentColor";
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
      <path d="M14 12 H48 L43 22 H9 Z" fill={trackFill} />
      <path
        d="M21 27 H55 L50 37 H16 Z"
        fill={isBrand ? "var(--brand-lead)" : "currentColor"}
        opacity={isBrand ? undefined : 0.45}
      />
      <path d="M14 42 H48 L43 52 H9 Z" fill={trackFill} />
    </svg>
  );
}
