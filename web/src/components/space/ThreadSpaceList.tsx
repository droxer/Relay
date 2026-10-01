"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { SpaceItem } from "../../lib/threadSpace";
import { ArtifactKindIcon } from "../artifact/ArtifactIndexStrip";
import { artifactFileName } from "../../lib/artifactPreview";
import { Button } from "@/components/ui/button";
import { ICON } from "../icons";

function formatRowTime(value: string, locale: string | undefined): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatRowSize(bytes: number | undefined, kind: string, t: TFunction, locale: string | undefined): string {
  if (typeof bytes !== "number" || Number.isNaN(bytes)) {
    return t(`artifact.kind.${kind}`, { defaultValue: kind });
  }
  const units = [
    { key: "mb", value: 1024 * 1024 },
    { key: "kb", value: 1024 },
  ] as const;
  const unit = units.find((item) => bytes >= item.value);
  if (unit) {
    const formatted = new Intl.NumberFormat(locale, {
      maximumFractionDigits: bytes >= unit.value * 10 ? 0 : 1,
    }).format(bytes / unit.value);
    return t(`artifact.size_${unit.key}`, { count: formatted });
  }
  return t("artifact.size_bytes", { count: new Intl.NumberFormat(locale).format(bytes) });
}

/** The `is-new` class only has to outlive the one-shot flash keyframe
 *  (--t-slow, 280ms); holding it longer keeps dead state on the row. */
const NEW_ITEM_HIGHLIGHT_MS = 600;

export function ThreadSpaceList({
  items,
  showProducer,
  selectedId,
  onSelect,
}: {
  items: SpaceItem[];
  showProducer: boolean;
  selectedId: string | null;
  onSelect: (artifactId: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const [highlightedIds, setHighlightedIds] = useState<ReadonlySet<string>>(new Set());
  // Seeded with the first render's ids so opening the panel on an existing
  // thread highlights nothing; only arrivals after that get the flash.
  const knownIdsRef = useRef<Set<string> | null>(null);
  if (knownIdsRef.current === null) {
    knownIdsRef.current = new Set(items.map((item) => item.artifact.id));
  }

  // The timer lives outside the effect body: an `items` change that brings no
  // new ids must not cancel the pending clear (the cleanup would fire, the
  // early return would skip re-arming, and the highlight would never lift).
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
  }, []);

  useEffect(() => {
    const known = knownIdsRef.current ?? new Set<string>();
    const fresh = items.filter((item) => !known.has(item.artifact.id)).map((item) => item.artifact.id);
    for (const item of items) known.add(item.artifact.id);
    knownIdsRef.current = known;
    if (fresh.length === 0) return;
    setHighlightedIds(new Set(fresh));
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      clearTimerRef.current = null;
      setHighlightedIds(new Set());
    }, NEW_ITEM_HIGHLIGHT_MS);
  }, [items]);

  return (
    <div className="thread-space-list" role="list" aria-label={t("space.list_label")}>
      {items.map((item) => {
        const { artifact } = item;
        const time = formatRowTime(artifact.createdAt, i18n.language || undefined);
        const size = formatRowSize(artifact.bytes, artifact.kind, t, i18n.language || undefined);
        const meta = [showProducer && item.producerLabel ? item.producerLabel : null, time || null, size]
          .filter(Boolean)
          .join(" · ");
        return (
          // The listitem role belongs on the wrapper: putting it on the button
          // would replace the button role, and AT would announce a focusable
          // list item with no press affordance.
          <div key={artifact.id} role="listitem" className="thread-space-row-slot">
            <Button
              variant="ghost"
              type="button"
              className={`thread-space-row${artifact.id === selectedId ? " is-active" : ""}${highlightedIds.has(artifact.id) ? " is-new" : ""}`}
              data-kind={artifact.kind}
              aria-current={artifact.id === selectedId || undefined}
              onClick={() => onSelect(artifact.id)}
            >
              <span className="thread-space-row-icon" aria-hidden="true">
                <ArtifactKindIcon kind={artifact.kind} size={ICON.sm} name={artifactFileName(artifact)} />
              </span>
              <span className="thread-space-row-copy">
                <span className="thread-space-row-title">{artifact.title}</span>
                <span className="thread-space-row-meta">{meta}</span>
              </span>
            </Button>
          </div>
        );
      })}
    </div>
  );
}
