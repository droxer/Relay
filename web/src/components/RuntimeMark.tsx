import { cn } from "@/lib/utils";
import type { AgentName, Tone } from "../types";
import type { NodeAgentPresence } from "../lib/adminHelpers";
import { runtimePip, type RuntimeMarkVariant } from "../lib/runtimePresence";
import { AgentMark } from "./AgentMark";
import { StateMark } from "./StateMark";
import { ICON } from "./icons";

/**
 * One executor on one computer: a presence pip, beside the vendor glyph when
 * no name sits next to it.
 *
 * This existed twice — `.adm-runtime-mark` on the fleet card and row, and
 * `.computer-runtime-row` on the computer page — and the copies had already
 * drifted: computer.css re-derived every presence rule against a
 * hand-drawn dot it borrowed from the admin stylesheet (since removed), and the two
 * disagreed on the healthy fill (`var(--tone)` versus `var(--ink-4)`). Both
 * also rolled their own filled/hollow rule instead of going through
 * `StateMark`, which is where that shape grammar is written down.
 *
 * The pip is a `StateMark` now, so shape comes from the one place: FILLED =
 * this runtime can take work right now, HOLLOW = it cannot. Hue then says why.
 * The presence → shape/hue rule itself lives in `lib/runtimePresence.ts`.
 */

export function RuntimeMark({
  agent,
  presence,
  tone,
  variant = "bare",
  disabled = false,
  className,
  glyphClassName,
  children,
  ...rest
}: {
  agent: AgentName;
  presence: NodeAgentPresence;
  tone: Tone;
  variant?: RuntimeMarkVariant;
  /** Dims the whole mark — an executor an admin has switched off. */
  disabled?: boolean;
  className?: string;
  /** Extra class for the vendor glyph, for call sites that tune its colour. */
  glyphClassName?: string;
  /** Labels that sit inside the mark on the `labeled` variant. */
  children?: React.ReactNode;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  const pip = runtimePip(presence, tone, variant);
  return (
    <span
      className={cn("runtime-mark", disabled && "is-disabled", className)}
      data-agent={agent}
      data-presence={presence}
      data-variant={variant}
      {...rest}
    >
      <StateMark shape={pip.shape} tone={pip.tone} className="runtime-mark-pip" />
      {/* The labeled variant sits beside the runtime's name, so the vendor
          glyph would only repeat it; the bare mark is the glyph alone. */}
      {variant === "labeled" ? null : <AgentMark agent={agent} size={ICON.sm} className={cn("runtime-mark-glyph", glyphClassName)} />}
      {children}
    </span>
  );
}
