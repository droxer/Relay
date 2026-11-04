"use client";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "@/components/ui/field";
import { NumberInput } from "@/components/ui/number-input";
import { DEFAULT_TASK_CAPACITY, MAX_TASK_CAPACITY } from "../../lib/taskCapacity";

export function TaskCapacityField({ id, value, onChange, inputRef, error }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  inputRef?: Ref<HTMLInputElement>;
  error?: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Field label={t("admin.v2.task_capacity_label")} hint={t("admin.v2.task_capacity_hint")}
      error={error ?? undefined} errorId={`${id}-error`} wrapper="div" htmlFor={id}>
      <NumberInput id={id} name="max-concurrent-tasks" min={1} max={MAX_TASK_CAPACITY}
        value={value} onValueChange={onChange} inputRef={inputRef}
        placeholder={String(DEFAULT_TASK_CAPACITY)} invalid={Boolean(error)} describedBy={error ? `${id}-error` : undefined} />
    </Field>
  );
}
