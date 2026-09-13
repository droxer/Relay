import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  /* Badge chrome: caption-bold (12px/700) on a `4px 8px` pad inside the
     CONTROL radius (--r-2, 6px), not a pill. The source system squares
     nothing, but at 20px badge heights a --r-full lozenge has more curve than
     edge and stops reading as a distinct shape next to the chips and buttons
     around it — see the radii block in palette.css. The source system's 10px
     inline pad has no token on the --sp-* grid (2.5 is a banned half-step),
     and the 12px step — carried over from the pill, where it cleared the
     curve — reads wide against a 6px radius, so the badge takes the 8px step.
     The leading status dot is a `StateMark` child, not a pseudo-element —
     see the variant table below. */
  "group/badge inline-flex w-fit shrink-0 items-center justify-center gap-1 truncate overflow-hidden rounded-md border px-2 py-0.5 text-micro font-medium whitespace-nowrap transition-[color,box-shadow,border-color,background-color] duration-(--t-fast) ease-(--ease) focus-visible:[outline:var(--focus-outline)] focus-visible:[outline-offset:var(--focus-offset)] focus-visible:ring-0 [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      /* Chrome only — border + ink per tone. The leading status dot is NOT
         drawn here: it is a `StateMark`, which is the one place the tone →
         shape grammar (ring for bad, pulse for live) is written down. Badge
         variants used to carry their own `before:` pseudo-dot, which made a
         member badge on /projects and a status pill on a thread row two
         different drawings of the same object. */
      variant: {
        neutral: "border-hairline bg-surface-strong text-ink",
        success: "border-success/35 bg-background text-success",
        info: "border-info/30 bg-background text-info",
        warning: "border-warning/30 bg-background text-warning",
        danger: "border-danger/35 bg-background text-danger",
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
    },
  }
)

function Badge({
  className,
  variant = "neutral",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge }
