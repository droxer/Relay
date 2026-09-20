"use client";

import type { ReactNode } from "react";

/* One facts band, printed under the page header on EVERY tab of a record
   surface. It exists because the three tabs used to be three unrelated
   container idioms for one entity — a padded card, a full-bleed file panel,
   and a full-bleed metric strip — and the facts that identify the record were
   scattered across all of them (a cramped header chip strip, a collapsed
   <details> in the profile, a metric strip that restated its own section
   headers).

   Two rules keep it from re-growing that way:

   1. Every field comes off the record object the caller already holds. No
      fetch — the band must survive a tab whose query is disabled.
   2. Nothing in a tab panel may restate a band field. The band owns the
      read-only facts; a tab owns its own work (editing, files, activity). */

export interface RecordFact {
  key: string;
  label: string;
  value: ReactNode;
  /** Long values (ids, node names) get the mono face and stay untranslated. */
  technical?: boolean;
  title?: string;
}

export function RecordBand({
  facts,
  label,
  variant = "band",
}: {
  facts: readonly RecordFact[];
  label: string;
  /** "band" is the full-width row under the header; "title" packs the same
      facts onto the header's title line, for pages whose tab panels need the
      vertical room the band row would take. */
  variant?: "band" | "title";
}) {
  if (!facts.length) return null;
  return (
    <dl className={variant === "title" ? "record-band record-band--title" : "record-band"} aria-label={label}>
      {facts.map((fact) => (
        <div className="record-band-cell" key={fact.key}>
          <dt className="record-band-label">{fact.label}</dt>
          <dd
            className={`record-band-value${fact.technical ? " code" : ""}`}
            title={fact.title}
            translate={fact.technical ? "no" : undefined}
          >
            {fact.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
