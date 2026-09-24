"use client";

import { useTranslation } from "react-i18next";
import type { CollaborationStyle } from "../types";
import { COLLABORATION_STYLES, effectiveStyle, previewSlots, type SlotMember } from "../lib/collaborationStyle";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";

export function CollaborationStyleSelect({ value, onChange, inheritLabel, compact, disabled, id, "aria-label": label }: {
  value: CollaborationStyle | null;
  onChange: (style: CollaborationStyle | null) => void;
  inheritLabel?: string;
  compact?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const text = (style: string) => style === "inherit" ? inheritLabel : t(`collab_style.${style}`);
  return <Select value={value ? effectiveStyle(undefined, value) : "inherit"} disabled={disabled} onValueChange={(next) => {
    if (next === "inherit") onChange(null);
    else if (COLLABORATION_STYLES.includes(next as CollaborationStyle)) onChange(next as CollaborationStyle);
  }}>
    <SelectTrigger id={id} size={compact ? "sm" : "default"} aria-label={label} className={compact ? "w-auto max-w-full" : "w-full"}>
      <SelectValue>{(selected: string) => text(selected)}</SelectValue>
    </SelectTrigger>
    <SelectContent>
      {inheritLabel ? <SelectItem value="inherit">{inheritLabel}</SelectItem> : null}
      {COLLABORATION_STYLES.map((style) => <SelectItem key={style} value={style}>{t(`collab_style.${style}`)}</SelectItem>)}
    </SelectContent>
  </Select>;
}

export function CollaborationSlotPreview({ members, leadId, style, nameOf }: {
  members: SlotMember[]; leadId?: string; style: CollaborationStyle; nameOf: (id: string) => string;
}) {
  const { t } = useTranslation();
  const preview = previewSlots(members, leadId, style);
  return <p className="m-0 text-xs leading-normal text-muted-foreground" aria-live="polite">
    {preview.slots.map((slot, index) => <span key={`${slot.slot}-${index}`}>{index ? " · " : ""}{t(`collab_style.slot_${slot.slot}`)}: {nameOf(slot.memberId)}</span>)}
    {preview.fallbackFrom ? <span> — {t("collab_style.fallback_solo")}</span> : null}
  </p>;
}
