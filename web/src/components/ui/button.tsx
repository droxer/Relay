import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { NavRefresh } from "@/components/icons"
import { Tooltip } from "@/components/ui/tooltip"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-md border border-transparent bg-clip-padding text-xs font-bold whitespace-nowrap transition-[color,background-color,border-color,box-shadow,transform] duration-(--t-fast) ease-(--ease) outline-none select-none focus-visible:border-ring focus-visible:[outline:var(--focus-outline)] focus-visible:[outline-offset:var(--focus-offset)] active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-(--opacity-disabled) aria-invalid:border-destructive aria-invalid:[outline:var(--focus-outline-danger)] aria-invalid:[outline-offset:var(--focus-offset)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        /* Disabled drops OUT of the fill rather than fading through it. The
           shared `disabled:opacity-(--opacity-disabled)` is right for ghost/outline/link, where
           the label sits on the page's own surface, but half-opacity white on
           cobalt measures ~2.2:1 — and a filled CTA is exactly the button that
           spends most of its life disabled (admin Settings' Save is disabled
           until its field is dirty). */
        default:
          "bg-primary text-primary-foreground hover:bg-primary-active disabled:opacity-100 disabled:border-(--line-1) disabled:bg-(--surface-2) disabled:text-(--ink-4)",
        /* The neutral tiers wash with --control-fill rather than --surface-2.
           See the role's note in roles.css: a fixed surface step only lifts on
           the one plane it was sized against, and inverted on the --surface-3
           planes (dialog, drawer, popover) these buttons most often sit on. */
        /* `border-input` (--control-border) in BOTH registers, matching Input,
           Textarea, SelectTrigger, and Checkbox. This variant used to take
           --line-1 in light and --control-border in dark, which made it a
           visibly different control per register — and --line-1 is the
           STRUCTURAL hairline, too faint to carry a control boundary under
           WCAG 1.4.11. The border is an outline button's whole affordance. */
        outline:
          "border-input bg-(--control-fill) hover:bg-(--control-fill-hover) hover:text-foreground aria-expanded:bg-(--control-fill-hover) aria-expanded:text-foreground",
        secondary:
          "bg-(--control-fill) text-secondary-foreground hover:bg-(--control-fill-hover) aria-expanded:bg-(--control-fill-hover) aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-(--control-fill-hover) hover:text-foreground aria-expanded:bg-(--control-fill-hover) aria-expanded:text-foreground",
        /* Destructive reads in the source system's critical red: a hairline ring
           where ghost has none, --err ink, and a full inversion to the red
           fill with --on-err text on hover/focus. The shape signal (the ring)
           is kept alongside the hue so the variant survives forced-colors
           mode, where the red is dropped. */
        destructive:
          "border-destructive/45 text-destructive hover:border-destructive hover:bg-destructive hover:text-destructive-foreground focus-visible:border-destructive focus-visible:[outline:var(--focus-outline-danger)] focus-visible:[outline-offset:var(--focus-offset)] disabled:opacity-100 disabled:border-(--line-1) disabled:text-(--ink-4)",
        /* Circular icon-only action — the source system's 40px button-icon-circular:
           ink-3 idle; a control wash + line-2 + ink-1 on hover. Always paired
           with the `icon` (--control-h) / `icon-dense` (--control-h-xs) sizes.
           `tinted` swaps the hover to an --action wash; the `danger` modifier
           re-tints it to --err and adds the hairline that keeps the
           destructive signal alive under forced-colors. */
        icon: "text-(--ink-3) hover:border-(--line-2) hover:bg-(--control-fill-hover) hover:text-(--ink-1)",
      },
      size: {
        /* The source system's pill padding is `14px 30px` around a 14px label; at
           Relay's 44px --control-h the vertical half is the height, and the
           inline half rounds to the 24px step on the grid. */
        default:
          "h-(--control-h) gap-1.5 px-6 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        /* The text tier climbs with the size tier: xs 12px (caption) → dense, sm and
           default 13px (the source system's button-md, the base `text-xs`).
           Every tier takes the CONTROL radius (--r-2, 6px) from the base, not
           a pill: see the radii block in palette.css for why this app squares
           off the brand's lozenge. These tiers restate it only to win the
           tailwind-merge conflict inside a button group. */
        xs: "h-(--control-h-2xs) gap-1 rounded-md px-3 text-micro in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3",
        dense: "h-(--control-h-xs) gap-1 rounded-md px-4 text-xs in-data-[slot=button-group]:rounded-md has-data-[icon=inline-end]:pr-3 has-data-[icon=inline-start]:pl-3",
        sm: "h-(--control-h-sm) gap-1.5 px-4 text-xs",
        /* One step ABOVE `default`, on the --control-h-lg rung, for hero and
           dual-CTA pairs where the pill carries a marketing weight. */
        lg: "h-(--control-h-lg) gap-2 px-7 has-data-[icon=inline-end]:pr-5 has-data-[icon=inline-start]:pl-5",
        /* Drawer/footer call-to-action: full control height with stronger
           label typography. Replaces the old `.adm-form-actions` descendant
           override so footer buttons are styled explicitly.

           Shares `default`'s 13px/700 label and differs from it by padding
           alone — in this system the button label is ALREADY the bold tier
           (the source system's button-md is 14px/700), so a commit action cannot
           emphasise itself by getting heavier. It leads through the cobalt
           fill of the `default` variant and a wider pill. */
        cta: "h-(--control-h) gap-2 px-7",
        /* Square counterpart of `default`: the toolbar refresh buttons sit
           directly beside default-size buttons, so the icon tier tracks
           --control-h instead of a fixed height that rendered 8px short.
           `icon-dense`/`icon-xs` remain the dense tiers for in-row chrome. */
        icon: "size-(--control-h)",
        "icon-xs":
          "size-(--control-h-2xs) rounded-md in-data-[slot=button-group]:rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-dense":
          "size-(--control-h-xs) rounded-md in-data-[slot=button-group]:rounded-md",
        "icon-sm": "size-(--control-h-sm)",
        "icon-lg": "size-(--control-h-lg)",
      },
      /* Tinted hover for the `icon` variant — the icon communicates a colored
         action instead of the neutral ink hover. Declared after `variant` so
         these classes win the tailwind-merge conflict. */
      tinted: {
        true: "hover:border-transparent hover:bg-[color-mix(in_srgb,var(--action)_10%,transparent)] hover:text-(--action)",
        false: "",
      },
      /* Destructive intent on a QUIET tier — the icon-only row actions (delete
         a node, an employee, a chat link, a thread) and menu items where the
         `destructive` variant's resting ring, repeated down every row, would
         turn the surface into a wall of red. Neutral at rest, --err on
         hover/focus.

         The BORDER is the load-bearing part, not the hue. Forced-colors mode
         discards author colors, so a red-only hover leaves such a button
         indistinguishable from its neutral siblings — the destructive signal
         disappears exactly where it matters most. Pairing the hue with a
         hairline keeps a SHAPE signal that survives the color being dropped,
         which is the same reason the `destructive` variant carries a ring.

         Declared after `tinted` so it wins the tailwind-merge conflict when
         both are set (a tinted icon button that is destructive reads --err,
         not --action). */
      danger: {
        true: "hover:border-(--err) hover:bg-[color-mix(in_srgb,var(--err)_10%,transparent)] hover:text-(--err) focus-visible:border-(--err) focus-visible:text-(--err) focus-visible:[outline:var(--focus-outline-danger)] focus-visible:[outline-offset:var(--focus-offset)]",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Marks an in-flight action and adds the shared progress glyph. */
    loading?: boolean
    /** Optional replacement copy while loading; existing children stay visible by default. */
    loadingLabel?: ReactNode
    /** Hover/focus label for an icon-only action, and — unless `aria-label`
     *  says otherwise — the button's accessible name.
     *
     *  This replaces the `aria-label={x} title={x}` pair that 45 icon buttons
     *  were carrying. `title` is unreachable on touch, never fires on keyboard
     *  focus, and cannot be styled, so on a button whose only label it was, the
     *  label was effectively mouse-only. Pass a separate `aria-label` where the
     *  spoken name should be longer than the tooltip — naming the row a delete
     *  button acts on, say, which a visible tooltip would only repeat back. */
    tooltip?: ReactNode
  }

function Button({
  className,
  variant = "default",
  size = "default",
  tinted = false,
  danger = false,
  loading = false,
  loadingLabel,
  tooltip,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const button = (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-danger={danger || undefined}
      className={cn(buttonVariants({ variant, size, tinted, danger, className }))}
      aria-busy={loading || undefined}
      /* Before the spread, so an explicit `aria-label` at the call site
         still wins when the spoken name differs from the tooltip. */
      aria-label={typeof tooltip === "string" ? tooltip : undefined}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <NavRefresh className="spin" aria-hidden="true" /> : null}
      {loading && loadingLabel !== undefined ? loadingLabel : children}
    </ButtonPrimitive>
  )
  if (!tooltip) return button
  return <Tooltip content={tooltip}>{button}</Tooltip>
}

export { Button, buttonVariants, type ButtonProps }
