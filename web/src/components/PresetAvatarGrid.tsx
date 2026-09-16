"use client";

import { useTranslation } from "react-i18next";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { PRESET_AVATARS, type PresetAvatarKind } from "../lib/presetAvatars";

/**
 * The preset profile images for an agent or a team, as one radio group.
 *
 * Used by the create forms (where a random preset is already chosen) and by
 * the profile picker popover (where nothing is chosen unless the record is
 * already wearing a preset). Each tile is the image alone, so its accessible
 * name has to come from the label rather than the picture.
 */
export function PresetAvatarGrid({
  kind,
  value,
  onChange,
  labelledBy,
  disabled = false,
}: {
  kind: PresetAvatarKind;
  value: string | null;
  onChange: (url: string) => void;
  labelledBy?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const presets = PRESET_AVATARS[kind];
  return (
    <RadioGroup
      className="preset-avatar-grid"
      data-kind={kind}
      aria-labelledby={labelledBy}
      aria-label={labelledBy ? undefined : t("profile_image.presets")}
      disabled={disabled}
      value={value}
      onValueChange={(next) => onChange(next as string)}
    >
      {presets.map((url, index) => (
        <RadioGroupChoice
          key={url}
          value={url}
          className="preset-avatar-option"
          aria-label={t("profile_image.preset_option", { index: index + 1, total: presets.length })}
        >
          <img src={url} alt="" draggable={false} />
        </RadioGroupChoice>
      ))}
    </RadioGroup>
  );
}
