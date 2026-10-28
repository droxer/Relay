import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

/* Field labels share the 14px control size and 500 weight with
   --type-label. The component owns association and disabled styling. */

function Label({
  className,
  render,
  ...props
}: useRender.ComponentProps<"label">) {
  return useRender({
    defaultTagName: "label",
    props: mergeProps<"label">(
      {
        className: cn(
          "inline-flex items-center gap-1 text-sm font-medium text-body select-none",
          "group-data-[disabled=true]/field:pointer-events-none group-data-[disabled=true]/field:opacity-(--opacity-disabled)",
          "peer-disabled:cursor-not-allowed peer-disabled:opacity-(--opacity-disabled)",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "label" },
  })
}

export { Label }
