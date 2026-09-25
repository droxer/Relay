"use client";

import { useTranslation } from "react-i18next";
import type { CollaborationStyle } from "../types";
import { COLLABORATION_STYLES, effectiveStyle, previewSlots, type SlotMember } from "../lib/collaborationStyle";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "./ui/select";
import { CollaborationStyleIcon } from "./CollaborationStyleBadge";
import { CollaborationStyleDiagram } from "./CollaborationStyleDiagram";
import { RadioGroup, RadioGroupChoice } from "./ui/radio-group";
import { ActionRetry, DisclosureChevron } from "./icons";

export function CollaborationStyleSelect({ value, onChange, inheritLabel, inheritStyle, compact, disabled, id, "aria-label": label }: {
  value: CollaborationStyle | null;
  onChange: (style: CollaborationStyle | null) => void;
  inheritLabel?: string;
  /** The style "inherit" resolves to, so the inherit row can wear its glyph. */
  inheritStyle?: CollaborationStyle;
  compact?: boolean;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}) {
  const { t } = useTranslation();
  const inherited = inheritStyle ? effectiveStyle(undefined, inheritStyle) : undefined;
  const glyphFor = (selected: string) => selected === "inherit" ? inherited : selected as CollaborationStyle;
  return <Select value={value ? effectiveStyle(undefined, value) : "inherit"} disabled={disabled} onValueChange={(next) => {
    if (next === "inherit") onChange(null);
    else if (COLLABORATION_STYLES.includes(next as CollaborationStyle)) onChange(next as CollaborationStyle);
  }}>
    <SelectTrigger id={id} size={compact ? "sm" : "default"} aria-label={label}
      className={compact ? "collab-style-trigger w-auto max-w-full" : "collab-style-trigger w-full"}>
      <SelectValue>{(selected: string) => {
        const glyph = glyphFor(selected);
        return <>
          {glyph ? <CollaborationStyleIcon style={glyph} /> : null}
          {selected === "inherit" && inherited ? <span className="truncate">
            {t(`collab_style.${inherited}`)}<span className="collab-style-trigger-note"> · {t("collab_style.team_default_short")}</span>
          </span> : <span className="truncate">{selected === "inherit" ? inheritLabel : t(`collab_style.${selected}`)}</span>}
        </>;
      }}</SelectValue>
    </SelectTrigger>
    <SelectContent className="w-80 min-w-(--anchor-width) max-w-(--available-width) p-1" align="start" alignItemWithTrigger={false}>
      {inheritLabel ? <SelectItem value="inherit" aria-label={inheritLabel} className="collab-style-option collab-style-option-inherit">
        <span className="collab-style-option-art">{inherited ? <CollaborationStyleDiagram style={inherited} /> : null}</span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{inheritLabel}</span>
          <span className="text-xs leading-normal text-muted-foreground">{t("collab_style.inherit_hint")}</span>
        </span>
      </SelectItem> : null}
      {COLLABORATION_STYLES.map((style) => <SelectItem key={style} value={style} aria-label={t(`collab_style.${style}`)} className="collab-style-option">
        <span className="collab-style-option-art"><CollaborationStyleDiagram style={style} /></span>
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{t(`collab_style.${style}`)}</span>
          <span className="text-xs leading-normal text-muted-foreground">{t(`collab_style.${style}_hint`)}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}

/** The team-level picker: every style side by side as a card with its
 *  schematic, so the choice is made by seeing how work will move. */
export function CollaborationStyleCards({ value, onChange, disabled, "aria-labelledby": labelledBy }: {
  value: CollaborationStyle;
  onChange: (style: CollaborationStyle) => void;
  disabled?: boolean;
  "aria-labelledby"?: string;
}) {
  const { t } = useTranslation();
  const selected = effectiveStyle(undefined, value);
  return <RadioGroup className="collab-style-cards" aria-labelledby={labelledBy} disabled={disabled} value={selected}
    onValueChange={(next) => {
      if (COLLABORATION_STYLES.includes(next as CollaborationStyle)) onChange(next as CollaborationStyle);
    }}>
    {COLLABORATION_STYLES.map((style) => <RadioGroupChoice key={style} value={style} className="collab-style-card"
      aria-label={t(`collab_style.${style}`)}>
      <span className="collab-style-card-art"><CollaborationStyleDiagram style={style} /></span>
      <span className="collab-style-card-name">
        <CollaborationStyleIcon style={style} className="size-3.5" />
        {t(`collab_style.${style}`)}
      </span>
      <span className="collab-style-card-hint">{t(`collab_style.${style}_hint`)}</span>
    </RadioGroupChoice>)}
  </RadioGroup>;
}

/** Read-only statement of a team's style: schematic, name, and what it means. */
export function CollaborationStyleSummary({ style }: { style: CollaborationStyle }) {
  const { t } = useTranslation();
  const resolved = effectiveStyle(undefined, style);
  return <div className="collab-style-summary" data-style={resolved}>
    <span className="collab-style-card-art"><CollaborationStyleDiagram style={resolved} /></span>
    <span className="collab-style-summary-text">
      <span className="collab-style-summary-name">
        <CollaborationStyleIcon style={resolved} className="size-3.5" />
        {t(`collab_style.${resolved}`)}
      </span>
      <span className="collab-style-summary-hint">{t(`collab_style.${resolved}_hint`)}</span>
    </span>
  </div>;
}

const initialOf = (name: string) => Array.from(name.trim())[0]?.toUpperCase() ?? "?";

export function CollaborationSlotPreview({ members, leadId, style, nameOf }: {
  members: SlotMember[]; leadId?: string; style: CollaborationStyle; nameOf: (id: string) => string;
}) {
  const { t } = useTranslation();
  const preview = previewSlots(members, leadId, style);
  // Lead-led closes on the lead again; name that step for what it does.
  // A pipeline step is "a member"; its role is what tells the steps apart.
  const roleOf = (id: string) => members.find((member) => member.id === id)?.role;
  const slotLabel = (slot: string, memberId: string, index: number) => {
    const role = roleOf(memberId);
    if (slot === "member" && role) return t(`team_work.role_${role}`, { defaultValue: t("collab_style.slot_member") });
    return t(`collab_style.slot_${slot === "lead" && index > 0 ? "lead_summary" : slot}`);
  };
  const builder = preview.slots.find((slot) => slot.slot === "builder");
  const reviewer = preview.slots.find((slot) => slot.slot === "reviewer");
  return <div className="collab-style-preview" data-style={preview.style} aria-live="polite">
    <ol className="collab-style-sequence">
      {preview.slots.map((slot, index) => <li key={`${slot.slot}-${index}`} data-slot={slot.slot}>
        {index > 0 ? <DisclosureChevron aria-hidden="true" className="collab-style-arrow" /> : null}
        <span className="collab-style-step">
          <span className="collab-style-step-avatar" aria-hidden="true">{initialOf(nameOf(slot.memberId))}</span>
          <span className="collab-style-step-text">
            <span className="collab-style-step-role">{slotLabel(slot.slot, slot.memberId, index)}<span className="sr-only">: </span></span>
            <span className="collab-style-step-name">{nameOf(slot.memberId)}</span>
          </span>
        </span>
      </li>)}
    </ol>
    {builder && reviewer ? <p className="collab-style-loop">
      <ActionRetry aria-hidden="true" className="size-3.5 shrink-0" />
      <span>{t("collab_style.loop_until_approved", { builder: nameOf(builder.memberId), reviewer: nameOf(reviewer.memberId) })}</span>
    </p> : null}
    {preview.fallbackFrom ? <p className="collab-style-loop">{t("collab_style.fallback_solo")}</p> : null}
  </div>;
}
