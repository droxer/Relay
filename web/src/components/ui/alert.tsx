"use client"

import { cva, type VariantProps } from "class-variance-authority"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"

import { cn } from "@/lib/utils"

/* Alert — the failure message a surface prints after an action goes wrong.
   Thirty-one of these were written by hand, each remembering `role="alert"`
   for itself. That role is the whole point of the component: without it the
   message appears silently for a screen-reader user, and nothing on screen
   shows the difference, which is exactly the kind of omission that survives
   review.

   Two shapes, because the app genuinely has two. `boxed` is the drawer and
   form footer message — a tinted panel, the old `.adm-form-error`. `inline`
   is a line of danger text under a control or above a list, the old
   `.adm-view-error` and the per-surface one-offs.

   Not a live region beyond `role="alert"`, which is already assertive.
   Something that reports progress rather than failure wants `role="status"`
   and is not this component. */

const alertVariants = cva("text-danger", {
  variants: {
    variant: {
      boxed:
        "m-0 rounded-md border border-(--tone-line) px-4 py-3 text-dense leading-normal [--tone:var(--err)]",
      inline: "m-0 text-dense",
    },
  },
  defaultVariants: {
    variant: "inline",
  },
})

function Alert({
  className,
  variant = "inline",
  render,
  ...props
}: useRender.ComponentProps<"p"> & VariantProps<typeof alertVariants>) {
  return useRender({
    defaultTagName: "p",
    props: mergeProps<"p">(
      {
        role: "alert",
        className: cn(alertVariants({ variant }), className),
      },
      props
    ),
    render,
    state: { slot: "alert", variant },
  })
}

export { Alert, alertVariants }
