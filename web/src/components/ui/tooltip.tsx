"use client"

import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import type { ReactElement, ReactNode } from "react"

import { cn } from "@/lib/utils"

/* Tooltip — the styled replacement for the native `title` attribute on
   controls where `title` was the ONLY label a sighted user got: icon-only
   buttons, and the status badges that carry their reading in a tooltip and
   `sr-only` text. `title` fails those cases three ways — it never appears on
   touch, it never appears on keyboard focus, and it cannot be styled, so the
   one label an icon button has arrived in OS chrome after a second's delay.

   `title` is left alone where it is SUPPLEMENTARY: a truncated id whose full
   value is a convenience, a timestamp behind a relative date. Those already
   have a visible label, and replacing them all would trade a cheap attribute
   for a mounted React subtree on every row of every list.

   A tooltip is never the accessible name. Every call site keeps its
   `aria-label`, and the popup is `aria-hidden` — announcing it as a
   description on focus would make a screen reader read the same words twice. */

const TooltipProvider = TooltipPrimitive.Provider

function TooltipContent({
  className,
  side = "top",
  sideOffset = 6,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "side" | "sideOffset" | "align">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        className="isolate z-(--z-float)"
      >
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          aria-hidden="true"
          className={cn(
            "max-w-64 origin-(--transform-origin) rounded-md bg-popover px-2 py-1 text-xs font-medium text-popover-foreground shadow-(--shadow-2) transition-[opacity,transform] duration-(--t-fast) ease-(--ease) data-[closed]:scale-95 data-[closed]:opacity-0 data-[open]:opacity-100",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

/** The whole control in one element: wrap the trigger, pass the words.
 *  Renders nothing extra when `content` is empty, so a call site with an
 *  optional label does not need a branch of its own. */
function Tooltip({
  content,
  children,
  side,
  align,
  ...props
}: Omit<TooltipPrimitive.Root.Props, "children"> & {
  content: ReactNode
  children: ReactElement<Record<string, unknown>>
  side?: TooltipPrimitive.Positioner.Props["side"]
  align?: TooltipPrimitive.Positioner.Props["align"]
}) {
  if (!content) return children
  return (
    <TooltipPrimitive.Root {...props}>
      <TooltipPrimitive.Trigger render={children} />
      <TooltipContent side={side} align={align}>
        {content}
      </TooltipContent>
    </TooltipPrimitive.Root>
  )
}

export { Tooltip, TooltipContent, TooltipProvider }
