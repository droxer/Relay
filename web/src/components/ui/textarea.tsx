import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-field bg-background px-3 py-2 text-sm text-foreground transition-[color,box-shadow,border-color] outline-none hover:border-field-hover placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-0 disabled:cursor-not-allowed disabled:opacity-(--opacity-disabled) aria-invalid:border-destructive aria-invalid:[outline:var(--focus-outline-danger)] aria-invalid:[outline-offset:var(--focus-offset)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
