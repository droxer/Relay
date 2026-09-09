import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"

import { cn } from "@/lib/utils"
import { CheckIcon } from "../icons"

/* Checkbox — base-ui primitive on the shared focus/invalid contract, so
   option rows stop hand-rolling native <input type="checkbox"> (OS chrome,
   no theme). The box is 16px on the 4px grid, matching the switch thumb;
   the ::after stretches the hit area to the 44px touch floor without
   growing the visible box (same trick as the switch). */
function Checkbox({ className, ...props }: CheckboxPrimitive.Root.Props) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background transition-[color,background-color,border-color,box-shadow] outline-none after:absolute after:-inset-x-1 after:-inset-y-3.5 focus-visible:border-ring focus-visible:[outline:var(--focus-outline)] focus-visible:[outline-offset:var(--focus-offset)] data-checked:border-[var(--action)] data-checked:bg-[var(--action)] data-checked:text-on-primary data-disabled:cursor-not-allowed data-disabled:opacity-(--opacity-disabled) aria-invalid:border-destructive aria-invalid:[outline:var(--focus-outline-danger)] aria-invalid:[outline-offset:var(--focus-offset)]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current"
      >
        <CheckIcon className="size-3" strokeWidth={3} aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
