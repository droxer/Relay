"use client";

import type { ReactNode } from "react";
import { RecordBand, type RecordFact } from "./RecordBand";

/**
 * A record page's body with its properties beside it: the tab content on the
 * left, the record's facts as plain label/value rows in a column on the right.
 *
 * This is the one shape every record takes — an agent, a team, an issue — so
 * they read as one product. It replaces a full-width band of tracked caps
 * cells under the header: a stats strip read as a dashboard, and every record
 * had laid its facts out differently (a strip, a row of chips, labels on the
 * title line). The facts still come off the record the caller already holds,
 * so the column survives every tab — RecordBand's contract is unchanged.
 *
 * Narrow panes fold the column above the body as one wrapping line of facts
 * (see record-layout in workspace.css).
 */
export function RecordLayout({
  facts,
  label,
  children,
}: {
  facts: readonly RecordFact[];
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="record-layout">
      {children}
      {facts.length ? (
        <aside className="record-layout-aside">
          <RecordBand facts={facts} label={label} variant="panel" />
        </aside>
      ) : null}
    </div>
  );
}
