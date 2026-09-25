import type { CollaborationStyle } from "../types";
import { effectiveStyle } from "../lib/collaborationStyle";
import { cn } from "../lib/utils";

/* A schematic of how work moves through a team in each style. It is drawn in
   currentColor, so the caller decides emphasis (ink at rest, action when the
   style is selected); stroke vs fill separates the lead from members, so the
   picture never depends on color alone. Decorative: the style name and hint
   beside it carry the meaning for assistive tech. */

const R = 5.5;

function Node({ x, y, lead }: { x: number; y: number; lead?: boolean }) {
  return <circle cx={x} cy={y} r={R} className={lead ? "collab-diagram-node-lead" : "collab-diagram-node"} />;
}

/** A straight link that ends in a small open chevron pointing along it. */
function Link({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const head = (spread: number) =>
    `${x2 - 4 * Math.cos(angle - spread)},${y2 - 4 * Math.sin(angle - spread)}`;
  return <g className="collab-diagram-link">
    <line x1={x1} y1={y1} x2={x2} y2={y2} />
    <polyline points={`${head(0.6)} ${x2},${y2} ${head(-0.6)}`} />
  </g>;
}

function BuildReview() {
  return <>
    <Node x={22} y={18} />
    <Node x={66} y={18} />
    <Link x1={29} y1={18} x2={58} y2={18} />
    {/* Changes requested: the work goes back to the builder. */}
    <g className="collab-diagram-link collab-diagram-return">
      <path d="M66 25 C 62 41, 26 41, 22 26" />
      <polyline points="18.6,29.6 22,25.6 25.8,28.8" />
    </g>
  </>;
}

function Pipeline() {
  return <>
    <Node x={12} y={24} />
    <Node x={44} y={24} />
    <Node x={76} y={24} />
    <Link x1={19} y1={24} x2={36} y2={24} />
    <Link x1={51} y1={24} x2={68} y2={24} />
  </>;
}

function LeadLed() {
  const members = [9, 24, 39];
  return <>
    <Node x={12} y={24} lead />
    {members.map((y) => <Node key={y} x={44} y={y} />)}
    <Node x={76} y={24} lead />
    {members.map((y) => <g key={`l-${y}`} className="collab-diagram-link">
      <line x1={18} y1={24} x2={38} y2={y} />
      <line x1={50} y1={y} x2={70} y2={24} />
    </g>)}
  </>;
}

export function CollaborationStyleDiagram({ style, className }: { style?: CollaborationStyle; className?: string }) {
  const resolved = effectiveStyle(undefined, style);
  return <svg viewBox="0 0 88 48" aria-hidden="true" focusable="false" data-style={resolved}
    className={cn("collab-diagram", className)}>
    {resolved === "pipeline" ? <Pipeline /> : resolved === "lead_led" ? <LeadLed /> : <BuildReview />}
  </svg>;
}
