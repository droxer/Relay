"use client";

import type { ReactNode } from "react";

interface KpiTileProps {
  eyebrow: string;
  value: ReactNode;
  slot?: "sessions" | "success" | "nodes" | "users" | "tokens";
  /** A small trend or share readout beside the numeral (sparkline, meter). */
  visual?: ReactNode;
  delta?: {
    label: string;
    direction: "up" | "down" | "flat";
  };
  hint?: string;
  /** A status hue for a reading that is a problem when nonzero. Most tiles
   *  carry none; the value stays ink. */
  tone?: "bad" | "warn";
}

export function KpiTile({ eyebrow, value, slot, visual, delta, hint, tone }: KpiTileProps) {
  const hasFoot = Boolean(delta || hint);
  const slotClass = slot ? ` adm-dash-tile--${slot}` : "";
  const toneClass = tone ? ` adm-dash-tile--toned tone-${tone}` : "";
  return (
    <div
      className={`adm-dash-tile${slotClass}${toneClass}`}
    >
      <div className="adm-dash-tile-eyebrow">
        <i className="adm-dash-tile-key" aria-hidden="true" />
        {eyebrow}
      </div>
      <div className="adm-dash-tile-reading">
        <div className="adm-dash-tile-value tnum">{value}</div>
        {visual ? <div className="adm-dash-tile-visual">{visual}</div> : null}
      </div>
      {hasFoot ? (
        <div className="adm-dash-tile-foot">
          {/* A trend direction is not a status tone: "went up" carries no hue
              of its own, and spelling it `tone-up` put it in a vocabulary whose
              every other member promises one. Keyed on a data attribute. */}
          {delta ? (
            <span className="adm-dash-delta" data-direction={delta.direction}>
              <span className="adm-dash-delta-glyph" aria-hidden="true">
                {delta.direction === "up" ? "▲" : delta.direction === "down" ? "▼" : "—"}
              </span>
              <span>{delta.label}</span>
            </span>
          ) : hint ? (
            <span className="adm-dash-tile-hint">{hint}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
