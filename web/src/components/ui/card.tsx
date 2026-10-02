import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/* Card — shadcn's slot vocabulary (card / card-header / card-title /
   card-description / card-action / card-content / card-footer) on the system's
   flat elevation model.

   Two deliberate departures from upstream shadcn:
   - No `shadow-sm`. Planes here are separated by hairlines, never lift
     (`--shadow-1: none` in roles.css). A drop shadow would be the only faux
     depth in the app.
   - Padding is --sp-5 (20px) on the 4px scale rather than shadcn's 24px, which
     is what the existing admin cards already used.

   `interactive` is for cards that are themselves a target (fleet nodes,
   employees): the hairline strengthens on hover instead of the surface washing,
   so a hovered card never competes with a selected row. */
const cardVariants = cva(
  "flex min-w-0 flex-col rounded-lg border border-hairline bg-card text-card-foreground",
  {
    variants: {
      variant: {
        default: "",
        interactive:
          "transition-[border-color] duration-(--t-fast) ease-(--ease) hover:border-hairline-strong",
      },
      padding: {
        default: "gap-4 p-5",
        compact: "gap-3 p-4",
        none: "",
      },
    },
    defaultVariants: { variant: "default", padding: "default" },
  }
)

function Card({
  className,
  variant,
  padding,
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof cardVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn(cardVariants({ variant, padding }), className) },
      props
    ),
    render,
    state: { slot: "card", variant },
  })
}

/* Header is a grid, not a flex row, so an optional CardAction can occupy a
   second column spanning both title and description rows — the layout the
   admin cards were building by hand with absolute positioning. */
function CardHeader({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "grid auto-rows-min items-start gap-1 has-data-[slot=card-action]:grid-cols-[minmax(0,1fr)_auto]",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-header" },
  })
}

function CardTitle({
  className,
  render,
  ...props
}: useRender.ComponentProps<"h3">) {
  return useRender({
    defaultTagName: "h3",
    props: mergeProps<"h3">(
      {
        // Card title — the source system's subtitle-lg tier, worn as the
        // --type-heading role (700 / 18px / --leading-heading): not the display
        // tier — only the 24px rung tracks tight, and font-display aliases the
        // sans the card already inherits.
        className: cn(
          "m-0 text-lg leading-(--leading-heading) font-bold tracking-(--track-0) text-ink",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-title" },
  })
}

function CardDescription({
  className,
  render,
  ...props
}: useRender.ComponentProps<"p">) {
  return useRender({
    defaultTagName: "p",
    props: mergeProps<"p">(
      { className: cn("m-0 text-sm text-muted-foreground", className) },
      props
    ),
    render,
    state: { slot: "card-description" },
  })
}

/* Trailing control in the header — a status pill, a menu, an overflow button. */
function CardAction({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "col-start-2 row-span-2 row-start-1 flex shrink-0 items-center gap-2 self-start justify-self-end",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-action" },
  })
}

function CardContent({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      { className: cn("min-w-0", className) },
      props
    ),
    render,
    state: { slot: "card-content" },
  })
}

/* `[.border-t]:pt-3` — a footer only pays for the divider padding when the
   call site actually asks for a divider, matching shadcn's opt-in rule. */
function CardFooter({
  className,
  render,
  ...props
}: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "mt-auto flex items-center gap-3 border-hairline-soft [.border-t]:pt-3",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "card-footer" },
  })
}

export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  cardVariants,
}
