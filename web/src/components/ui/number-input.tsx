"use client"

import type { Ref } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { draftFromNumber, numberFromDraft } from "@/lib/numberInput"
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "@/components/reui/number-field"

/* An integer field with step buttons, over ReUI's number-field.

   The group owns the field border, growing height and shared focus ring.
   The input and inset step buttons use the same NumberField primitives as
   standalone numeric controls.

   The step buttons are out of the tab order (base-ui's default); Arrow
   Up/Down on the input steps the value.

   Pair it with `<Field wrapper="div" htmlFor={id}>`: inside a wrapping
   <label> the first labelable element is the decrement button, which would
   take the label's name and fire on a label click. */
function NumberInput({
  id,
  name,
  value,
  onValueChange,
  min,
  max,
  step = 1,
  disabled,
  placeholder,
  invalid,
  describedBy,
  inputRef,
  className,
}: {
  id: string
  name?: string
  /** "" is an empty field, which callers may give a meaning (e.g. "use the default"). */
  value: string
  onValueChange: (value: string) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  placeholder?: string
  invalid?: boolean
  describedBy?: string
  inputRef?: Ref<HTMLInputElement>
  className?: string
}) {
  const { t } = useTranslation()
  const stepButton =
    "absolute inset-y-0 z-1 border-0 px-2 text-muted-foreground hover:bg-transparent hover:text-foreground"

  return (
    <NumberField
      id={id}
      name={name}
      value={numberFromDraft(value)}
      onValueChange={(next) => onValueChange(draftFromNumber(next))}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      className={cn("gap-0", className)}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={t("number_field.decrease")} className={cn(stepButton, "start-0")} />
        <NumberFieldInput
          ref={inputRef}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="px-9 placeholder:text-muted-foreground disabled:cursor-not-allowed"
        />
        <NumberFieldIncrement aria-label={t("number_field.increase")} className={cn(stepButton, "end-0")} />
      </NumberFieldGroup>
    </NumberField>
  )
}

export { NumberInput }
