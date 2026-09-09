"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"

import { cn } from "@/lib/utils"

/* Radio group — base-ui primitive on the shared focus/invalid contract.
   Three surfaces used to hand-roll this control three different ways: a
   native <input type="radio"> stretched under a row (the node picker), the
   same trick under a segment (the run-mode switch), and `<button role="radio">`
   with a hand-written roving tabindex (preferences). Three keyboard models for
   one widget. The primitive owns arrow-key roving, `aria-checked`, the hidden
   form input, and Field wiring, so a call site only chooses a SKIN.

   Two skins ship here. `RadioGroupItem` is the conventional dial + label. Both
   bespoke skins go through `RadioGroupChoice`, which draws nothing at all: it
   is the item's semantics on the caller's own class, exposing `data-checked`
   so the existing stylesheet keeps drawing the selected state it always drew.

   The focus ring needs no help in either skin. base.css draws it on
   `button:focus-visible`, and every part below renders a <button>, so the
   stretched-transparent-input trick these rows used to need — an invisible box
   covering the row purely so a ring would land on its geometry — is gone with
   the native input that required it. */

function RadioGroup<Value>({
  className,
  ...props
}: RadioGroupPrimitive.Props<Value>) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      className={cn("grid gap-2", className)}
      {...props}
    />
  )
}

/** The conventional dial. Sized and bordered like Checkbox, so a form that
 *  mixes the two reads as one control family. */
function RadioGroupItem({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-background transition-[color,background-color,border-color,box-shadow] outline-none after:absolute after:-inset-x-1 after:-inset-y-3.5 focus-visible:border-ring focus-visible:[outline:var(--focus-outline)] focus-visible:[outline-offset:var(--focus-offset)] data-checked:border-[var(--action)] data-checked:bg-[var(--action)] data-disabled:cursor-not-allowed data-disabled:opacity-(--opacity-disabled) aria-invalid:border-destructive aria-invalid:[outline:var(--focus-outline-danger)] aria-invalid:[outline-offset:var(--focus-offset)]",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator
        data-slot="radio-group-indicator"
        className="size-1.5 rounded-full bg-on-primary"
      />
    </RadioPrimitive.Root>
  )
}

/** Unstyled radio semantics for surfaces that draw their own selected shape — a
 *  full list row, a segment of a segmented control. The caller's stylesheet
 *  keys off `[data-checked]`; nothing is drawn here. */
function RadioGroupChoice({ className, ...props }: RadioPrimitive.Root.Props) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-choice"
      className={cn("cursor-pointer text-left font-[inherit]", className)}
      {...props}
    />
  )
}

export { RadioGroup, RadioGroupItem, RadioGroupChoice }
