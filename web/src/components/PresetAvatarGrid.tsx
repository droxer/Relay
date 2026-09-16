"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { PRESET_AVATAR_STYLES, type PresetAvatarKind } from "../lib/presetAvatars";

/**
 * The preset profile images for an agent or a team, as one radio group.
 *
 * Used by the create forms (where a random preset is already chosen) and by
 * the profile picker popover (where nothing is chosen unless the record is
 * already wearing a preset). A kind with several styles is split into labelled
 * sections, but it stays a single group so the arrow keys walk every preset.
 * Each tile is the image alone, so its accessible name comes from the label.
 *
 * In a radio group the arrow keys *select*. That is right for a form, where
 * nothing is saved until submit, but a surface that saves on selection passes
 * `onCommit`: it runs on click, which base-ui's button also fires for Enter
 * and Space, while an arrow key only moves the highlight — arrow selection
 * clicks the hidden input, never the tile.
 */
export function PresetAvatarGrid({
  kind,
  value,
  onChange,
  onCommit,
  labelledBy,
  disabled = false,
}: {
  kind: PresetAvatarKind;
  value: string | null;
  onChange: (url: string) => void;
  onCommit?: (url: string) => void;
  labelledBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const sectionIdPrefix = useId();
  const styles = PRESET_AVATAR_STYLES[kind];
  const sectioned = styles.length > 1;
  return (
    <RadioGroup
      className="preset-avatar-picker"
      data-kind={kind}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : t("profile_image.presets")}
      disabled={disabled}
      value={value}
      onValueChange={(next) => onChange(next as string)}
    >
      {styles.map(({ style, urls }) => {
        const styleLabel = t(`profile_image.style.${style}`);
        const headingId = `${sectionIdPrefix}-${style}`;
        return (
          <div
            key={style}
            className="preset-avatar-section"
            role={sectioned ? "group" : undefined}
            aria-labelledby={sectioned ? headingId : undefined}
          >
            {sectioned ? (
              <span id={headingId} className="preset-avatar-section-title">{styleLabel}</span>
            ) : null}
            <div className="preset-avatar-grid" data-kind={kind}>
              {urls.map((url, index) => (
                <RadioGroupChoice
                  key={url}
                  value={url}
                  className="preset-avatar-option"
                  aria-label={t("profile_image.preset_option", { style: styleLabel, index: index + 1, total: urls.length })}
                  onClick={onCommit ? () => onCommit(url) : undefined}
                >
                  <img src={url} alt="" draggable={false} />
                </RadioGroupChoice>
              ))}
            </div>
          </div>
        );
      })}
    </RadioGroup>
  );
}
