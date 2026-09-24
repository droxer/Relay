"use client";

import { useTranslation } from "react-i18next";
import type { CollaborationStyle } from "../types";
import { COLLABORATION_STYLES, effectiveStyle, previewSlots, type SlotMember } from "../lib/collaborationStyle";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { CollaborationStyleIcon } from "./CollaborationStyleBadge";

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
      <SelectValue>{(selected: string) => <>
        {selected !== "inherit" ? <CollaborationStyleIcon style={selected as CollaborationStyle} /> : null}
        <span className="truncate">{text(selected)}</span>
      </>}</SelectValue>
    </SelectTrigger>
    <SelectContent className="w-80 min-w-(--anchor-width) max-w-(--available-width) p-1" align="start" alignItemWithTrigger={false}>
      {inheritLabel ? <SelectItem value="inherit">{inheritLabel}</SelectItem> : null}
      {COLLABORATION_STYLES.map((style) => <SelectItem key={style} value={style} aria-label={t(`collab_style.${style}`)} className="collab-style-option">
        <span className="collab-style-icon" data-style={style}><CollaborationStyleIcon style={style} /></span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{t(`collab_style.${style}`)}</span>
          <span className="text-xs leading-normal text-muted-foreground">{t(`collab_style.${style}_hint`)}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}

export function CollaborationSlotPreview({ members, leadId, style, nameOf }: {
  members: SlotMember[]; leadId?: string; style: CollaborationStyle; nameOf: (id: string) => string;
}) {
  const { t } = useTranslation();
  const preview = previewSlots(members, leadId, style);
  return <div className="collab-style-preview" aria-live="polite">
    <ol className="collab-style-sequence">
      {preview.slots.map((slot, index) => <li key={`${slot.slot}-${index}`}>
        <span className="collab-style-step" aria-hidden="true">{index + 1}</span>
        <span><span className="text-muted-foreground">{t(`collab_style.slot_${slot.slot}`)}: </span><span className="font-medium">{nameOf(slot.memberId)}</span></span>
      </li>)}
    </ol>
    {preview.fallbackFrom ? <p className="m-0 text-xs text-muted-foreground">{t("collab_style.fallback_solo")}</p> : null}
  </div>;
}
