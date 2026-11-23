"use client"

import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group"

/* Choice group — the form control for a SMALL, FIXED set of values the form
   saves. A dropdown hides its options behind a click; when there are only two
   to seven short answers (priority, status, who accepts, what starts an
   automation) every answer fits on screen, so the reader compares them at a
   glance and picks in one press.

   Kept light (inputs.css): only the selected option carries a line, a thin
   --action outline over a faint wash. The layout follows the option count,
   not the call site:
   - `segments` (≤ 4 options): one hairline frame around plain-text options
     that grow to fill the row, and wrap whole inside the frame when the
     column is too narrow (phones).
   - `chips` (5+ options): hairline pills that keep their own width and
     wrap, the same weight as the weekday picker beside them.
   Dynamic lists — projects, computers, agents, time zones — stay a Select:
   their length is unbounded, and that is what a menu is for.

   Radio semantics throughout (base-ui): one tab stop, arrow keys move the
   choice, `aria-checked` on the selected item. Never a toggle group — that
   primitive is for view switches that change what is on screen, not what is
   saved. */

export type ChoiceOption<Value extends string> = {
  value: Value
  label: ReactNode
  /** Accessible name when `label` is not plain text. */
  ariaLabel?: string
  disabled?: boolean
}

export type ChoiceLayout = "segments" | "chips"

/** Up to this many options share one segmented track. */
export const SEGMENT_LIMIT = 4

export function choiceLayout(count: number): ChoiceLayout {
  return count <= SEGMENT_LIMIT ? "segments" : "chips"
}

type ChoiceGroupProps<Value extends string> = {
  value: Value
  options: readonly ChoiceOption<Value>[]
  onValueChange: (value: Value) => void
  /** Defaults to the count rule in `choiceLayout`. */
  layout?: ChoiceLayout
  /** `compact` for a switch that sits above another control rather than in a
   *  form row of its own. */
  size?: "default" | "compact"
  name?: string
  disabled?: boolean
  className?: string
  "aria-label"?: string
  "aria-labelledby"?: string
  "aria-describedby"?: string
  "aria-invalid"?: boolean
}

function ChoiceGroup<Value extends string>({
  value,
  options,
  onValueChange,
  layout,
  size = "default",
  name,
  disabled,
  className,
  ...aria
}: ChoiceGroupProps<Value>) {
  const resolved = layout ?? choiceLayout(options.length)
  const known = new Set<string>(options.map((option) => option.value))
  return (
    <RadioGroup
      data-slot="choice-group"
      data-layout={resolved}
      data-size={size}
      className={cn("choice-group", className)}
      name={name}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        // The primitive types its value loosely; only an offered value is
        // ever handed back to the form.
        if (typeof next === "string" && known.has(next) && next !== value) onValueChange(next as Value)
      }}
      {...aria}
    >
      {options.map((option) => (
        <RadioGroupChoice
          key={option.value}
          value={option.value}
          disabled={option.disabled}
          aria-label={option.ariaLabel}
          className="choice-group-item"
        >
          {option.label}
        </RadioGroupChoice>
      ))}
    </RadioGroup>
  )
}

export { ChoiceGroup }
