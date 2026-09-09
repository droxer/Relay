"use client"

import { Tabs as TabsPrimitive } from "@base-ui/react/tabs"

import { cn } from "@/lib/utils"

/* Tabs — base-ui primitive. Five surfaces (preferences, the agent record, the
   project and team workspaces, the thread space panel) each carried their own
   `role="tablist"`, their own ref map, and their own arrow-key handler. Same
   pattern five times, and each copy had to remember `tabIndex={selected ? 0 : -1}`,
   `aria-controls`, and a matching `aria-labelledby` on the panel — the parts
   that go silently wrong rather than visibly wrong.

   The primitive owns roving focus, Home/End, the id wiring between a tab and
   its panel, and `activateOnFocus`. What stays at the call site is the SKIN:
   every one of those surfaces has its own tablist chrome, so `TabsList` and
   `TabsTrigger` carry only layout and the shared focus contract and let the
   surface's own class do the drawing. */

const Tabs = TabsPrimitive.Root

/** `activateOnFocus` keeps the behaviour every migrated surface already had:
 *  an arrow key moves the selection, not just the focus ring. base-ui defaults
 *  to manual activation, which is the better default when a panel is
 *  expensive — but changing how these five surfaces respond to an arrow key is
 *  not something a primitive swap should decide on its own. */
function TabsList({ className, activateOnFocus = true, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      activateOnFocus={activateOnFocus}
      className={cn("flex items-center", className)}
      {...props}
    />
  )
}

function TabsTrigger({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-trigger"
      className={cn(
        "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap outline-none disabled:pointer-events-none disabled:opacity-(--opacity-disabled) [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className
      )}
      {...props}
    />
  )
}

/** `keepMounted={false}` is the default here, matching what every migrated
 *  surface already did by rendering its section only while active — a tab
 *  panel in this app can hold a whole workspace view. */
function TabsContent({
  className,
  keepMounted = false,
  ...props
}: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      keepMounted={keepMounted}
      className={cn("outline-none", className)}
      {...props}
    />
  )
}

export { Tabs, TabsList, TabsTrigger, TabsContent }
