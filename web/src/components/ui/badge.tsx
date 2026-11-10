import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  /* Standard badges use the 24px chip tier, 12px corners and 8px inline pad.
     Compact badges use 20px height, 8px corners and 6px pad for dense title
     lines. Both share the 12px/500 label and the same tone vocabulary. */
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 truncate overflow-hidden border text-xs font-medium whitespace-nowrap transition-[color,box-shadow,border-color,background-color] duration-(--t-fast) ease-(--ease) focus-visible:ring-0 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      size: {
        default: "min-h-(--chip-h) rounded-md px-2",
        compact: "min-h-(--chip-h-compact) rounded-sm px-1.5 leading-none",
      },
      /* Chrome only — border + ink per tone. The leading status dot is NOT
         drawn here: it is a `StateMark`, which is the one place the tone →
         shape grammar (ring for bad, pulse for live) is written down. Badge
         variants used to carry their own `before:` pseudo-dot, which made a
         member badge on /projects and a status pill on a thread row two
         different drawings of the same object. */
      variant: {
        /* Flat: a tint, not an outline. A toned edge around a toned word was
           two marks for one fact, and a row of status pills read as a row of
           little boxes. The fill carries the shape; the transparent border
           keeps the box model identical so nothing shifts. 8%, not 10%: on the
           canvas (--surface-0) a 10% green tint put --ok text at 4.49:1. */
        /* Neutral chips share --control-fill, the one chip plane: an ink
           tint lifts on every surface, where a fixed surface step inverted on
           the --surface-3 overlays. */
        neutral: "border-transparent bg-(--control-fill) text-ink",
        success: "border-transparent bg-success/8 text-success",
        info: "border-transparent bg-info/8 text-info",
        warning: "border-transparent bg-warning/8 text-warning",
        danger: "border-transparent bg-danger/8 text-danger",
        /* Chrome only — the caller's own stylesheet owns the border colour and
           ink. For badges whose tone scale is richer than the five semantic
           ones above: a routine's schedule health runs live → overdue → due →
           scheduled → unscheduled → paused, and a paused one is dashed, which
           no `variant` here expresses. Those surfaces used to redeclare the
           whole chip — padding, border, radius, type — to get at their accent,
           which is how two drawings of the same object appear. This keeps the
           one chip geometry and lets them keep their accent. */
        state: "border-(--tone-line) bg-transparent text-body",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "default",
    },
  }
)

function Badge({
  className,
  variant = "neutral",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant, size }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
      size,
    },
  })
}

export { Badge }
