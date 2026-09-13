"use client"

import type { ComponentProps } from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/lib/utils"

/* Dropdown menu — base-ui, replacing the last hand-rolled widget role in the
   app.
 *
 * The sidenav built two of these by hand: a portaled <div role="menu"> whose
 * items were found with `querySelectorAll('[role="menuitem"]')` and walked by
 * a local arrow-key handler, positioned by writing viewport coordinates into
 * `style={{ top, left }}`. That implementation was missing three things, none
 * of which is visible on screen:
 *
 * - Typeahead and Home/End. A menu is expected to jump to an item when you
 *   type its first letters; neither menu did.
 * - Collision handling. Fixed coordinates do not flip or shift, so a menu
 *   opened near the bottom of a short viewport rendered off-screen. The
 *   positioner anchors to the trigger and flips instead.
 * - Focus restore. Closing returned focus wherever the browser left it.
 *
 * It is also why this file exists rather than more `role="menuitem"` props on
 * <Button>: a role attribute makes an element *claim* to be a menu item, and
 * claiming is the whole bug — the element then owes the menu keyboard contract
 * that nothing was implementing.
 *
 * `MenuLinkItem` is the reason the sidenav's "more" menu can stay real <a>
 * elements: navigation items must remain links (middle-click, open-in-new-tab,
 * copy-link all die if they become buttons), and the primitive keeps the menu
 * semantics on top of an anchor instead of replacing it.
 *
 * Chrome matches `select.tsx` exactly — same popover surface, same flat
 * elevation (`--shadow-2`'s hairline ring, never a blur), same float layer —
 * because a menu popup and a select popup are the same object to a reader and
 * were two different drawings before.
 */

const DropdownMenu = MenuPrimitive.Root
const DropdownMenuTrigger = MenuPrimitive.Trigger
const DropdownMenuGroup = MenuPrimitive.Group

function DropdownMenuContent({
  className,
  side = "bottom",
  sideOffset = 6,
  align = "start",
  alignOffset = 0,
  anchor,
  collisionPadding = 8,
  ...popupProps
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "side" | "sideOffset" | "align" | "alignOffset" | "anchor" | "collisionPadding"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        anchor={anchor}
        collisionPadding={collisionPadding}
        className="isolate z-(--z-float)"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "relative isolate z-(--z-float) max-h-(--available-height) min-w-40 origin-(--transform-origin) overflow-y-auto rounded-md bg-popover p-1 text-popover-foreground shadow-(--shadow-2) transition-[opacity,transform] duration-(--t-fast) ease-(--ease) outline-none data-[open]:opacity-100 data-[closed]:scale-95 data-[closed]:opacity-0",
            className
          )}
          {...popupProps}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

/* Item chrome is shared by `Item` and `LinkItem` so a button row and a link row
   are the same drawing — the sidenav had `.sidenav-more-item` for the links and
   bare <Button variant="ghost"> for the actions, which is two of them. */
const itemClassName =
  "relative flex w-full cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs font-medium text-body no-underline outline-none select-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-(--opacity-disabled) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

/* `danger` mirrors the Button variant of the same name: neutral at rest, --err
   on highlight, and the hue is paired with nothing else that would survive
   forced-colors — so unlike Button's icon rows, a destructive menu item leans
   on its label to say what it does. Highlighting is the only state a menu item
   has, so there is no ring to add. */
function DropdownMenuItem({
  className,
  danger = false,
  ...props
}: MenuPrimitive.Item.Props & { danger?: boolean }) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-danger={danger || undefined}
      className={cn(
        itemClassName,
        danger &&
          "text-danger data-[highlighted]:bg-[color-mix(in_srgb,var(--err)_10%,transparent)] data-[highlighted]:text-danger",
        className
      )}
      {...props}
    />
  )
}

/** Navigation row. Keeps a real <a> — see the file header. */
function DropdownMenuLinkItem({
  className,
  ...props
}: MenuPrimitive.LinkItem.Props) {
  return (
    <MenuPrimitive.LinkItem
      data-slot="dropdown-menu-link-item"
      className={cn(
        itemClassName,
        "aria-[current=page]:bg-accent aria-[current=page]:text-ink",
        className
      )}
      {...props}
    />
  )
}

/** Names a group of items. MUST be inside a `DropdownMenuGroup` — the label is
 *  what gives the group its accessible name, so base-ui throws rather than
 *  rendering a heading that labels nothing. */
function DropdownMenuLabel({
  className,
  ...props
}: MenuPrimitive.GroupLabel.Props) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-micro text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="dropdown-menu-separator"
      role="none"
      className={cn("-mx-1 my-1 h-px bg-hairline", className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
