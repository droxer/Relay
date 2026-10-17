import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

/* Field label — the `--type-label` role expressed as utilities: text-xs
   resolves to --fs-1 (12px) and font-medium to 500. It must track the role:
   the compact pass moved --type-label and every control to --fs-1 but left
   this at text-sm, so a 14px label sat over a 12px value in every drawer. Having a
   real component means a label can carry `htmlFor`, react to a disabled peer,
   and be used outside `.adm-field` — none of which the descendant rule allowed.

   `select-none` keeps a double-click on the label from selecting its text
   instead of focusing the control, and the peer/group hooks mirror shadcn so a
   disabled field dims its label without the call site tracking state. */
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
          "inline-flex items-center gap-1 text-xs leading-none font-medium text-body select-none",
          "group-data-[disabled=true]/field:pointer-events-none group-data-[disabled=true]/field:opacity-50",
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
