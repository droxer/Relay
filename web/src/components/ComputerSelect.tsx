"use client";

import { forwardRef } from "react";
import { useTranslation } from "react-i18next";
import type { ComputerOwnership } from "../lib/createAgent";
import type { ComputerOption } from "../hooks/useComputerOptions";
import { ICON, nodeOwnershipIcon } from "./icons";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function ComputerOptionLabel({ label, ownership }: { label: string; ownership: ComputerOwnership }) {
  const { t } = useTranslation();
  const ComputerIcon = nodeOwnershipIcon(ownership);
  return (
    <span className="create-agent-computer-option">
      <ComputerIcon size={ICON.sm} aria-hidden="true" />
      <span className="create-agent-computer-name" translate="no">{label}</span>
      <span className="create-agent-computer-kind">{t(`admin.v2.node_ownership_${ownership}`)}</span>
    </span>
  );
}

/** One of the employee's computers, by stable identity. Agent creation and
 *  team setup both open with it: where something runs is chosen first. */
export const ComputerSelect = forwardRef<HTMLButtonElement, {
  options: ComputerOption[];
  value: string;
  onChange: (computerId: string) => void;
  placeholder: string;
  disabled?: boolean;
  labelledBy: string;
  error?: boolean;
  errorId?: string;
  initialFocus?: boolean;
}>(function ComputerSelect({ options, value, onChange, placeholder, disabled = false, labelledBy, error = false, errorId, initialFocus = false }, ref) {
  return (
    <Select value={value || null} onValueChange={(next) => onChange(next ?? "")} disabled={disabled}>
      <SelectTrigger
        ref={ref}
        data-modal-initial-focus={initialFocus || undefined}
        className="w-full"
        aria-labelledby={labelledBy}
        aria-invalid={error || undefined}
        aria-describedby={error ? errorId : undefined}
      >
        <SelectValue placeholder={placeholder}>
          {(selectedValue: string | null) => {
            const selected = options.find((option) => option.computerId === selectedValue);
            return selected
              ? <ComputerOptionLabel label={selected.label} ownership={selected.ownership} />
              : placeholder;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.computerId} value={option.computerId}>
            <ComputerOptionLabel label={option.label} ownership={option.ownership} />
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
});
