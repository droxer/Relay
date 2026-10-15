"use client";

import { useTranslation } from "react-i18next";

import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";

export type RunLocation = "managed" | "user-device";

interface RunModeFieldProps {
  value: RunLocation;
  onChange: (location: RunLocation) => void;
  /** Distinguishes radio groups when two drawers render the field. */
  name: string;
  disabled?: boolean;
}

const RUN_MODE_OPTIONS: Array<{ location: RunLocation; kind: "managed" | "local" }> = [
  { location: "managed", kind: "managed" },
  { location: "user-device", kind: "local" },
];

export function RunModeField({ value, onChange, name, disabled }: RunModeFieldProps) {
  const { t } = useTranslation();
  const activeKind = value === "managed" ? "managed" : "local";

  return (
    <div className="adm-profile-field">
      {/* A radio group, not a toggle group: this segment carries a submitted
          form value and is exclusive by nature. The toggle-group primitive is
          for view switches that change what is on screen, not what is saved. */}
      <RadioGroup
        className="adm-profile-segment"
        name={name}
        aria-label={t("admin.v2.run_mode")}
        disabled={disabled}
        value={value}
        onValueChange={(next) => onChange(next as RunLocation)}
      >
        {RUN_MODE_OPTIONS.map(({ location, kind }) => {
          const selected = value === location;
          return (
            <RadioGroupChoice
              key={location}
              className="adm-profile-segment-option"
              value={location}
            >
              <span className="adm-profile-segment-btn" data-active={selected ? "true" : "false"}>
                <span className="adm-profile-segment-dot" data-kind={kind} aria-hidden="true" />
                {t(`admin.v2.node_execution_${kind}`)}
              </span>
            </RadioGroupChoice>
          );
        })}
      </RadioGroup>
      <p className="adm-form-hint">{t(`admin.v2.profile_${activeKind}_desc`)}</p>
    </div>
  );
}
