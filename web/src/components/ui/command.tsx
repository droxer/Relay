"use client"

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"

import { cn } from "@/lib/utils"

/* Command — the always-open, filter-as-you-type list, on base-ui's Combobox.
 *
 * This is the INLINE combobox shape, not the popup one: no Portal, no
 * Positioner, no Popup. The list is not floating chrome that opens next to a
 * trigger — it IS the surface, sitting inside a Dialog that already owns the
 * scrim, the focus trap, and focus restore. So `CommandRoot` forces `open` and
 * lets the dialog decide whether any of it is on screen at all.
 *
 * `filter` is `null` on purpose. Base UI can filter the item list for you, but
 * this app already ranks commands in `lib/commandMenu.ts` — a match on a
 * command's own keywords scores differently from a match on its label, and
 * that ranking is the reason the palette feels right. Handing filtering to the
 * primitive would replace a tuned ranking with a substring test, so the
 * primitive gets the already-filtered, already-ordered list and owns only what
 * it is better at: the highlight roving, `aria-activedescendant`, the
 * listbox/option roles, and Enter-to-select.
 *
 * `Combobox.Empty` must stay mounted to announce politely, which is why the
 * empty copy is a child of it rather than a conditional branch around it.
 */

/* `autoHighlight` is `"always"`, not `true`. Plain `true` highlights the first
   item only WHILE FILTERING, so a palette opened and not yet typed into has
   nothing highlighted and a bare Enter does nothing — the old hand-rolled
   palette started at index 0, and opening ⌘K and pressing Enter to run the
   top command is the whole point of the shape.

   The cast is deliberate and is the reason this wrapper exists. Base UI's
   runtime reads `autoHighlight === "always"`, but `Combobox.Root`'s public
   prop type narrows the value it inherits to `boolean`. Absorbing that gap in
   one place beats either spreading the cast across call sites or changing the
   palette's behaviour to match a type. */
const ALWAYS_HIGHLIGHT = "always" as unknown as boolean

function Command<Value>({
  filter = null,
  autoHighlight = ALWAYS_HIGHLIGHT,
  ...props
}: ComboboxPrimitive.Root.Props<Value>) {
  return (
    <ComboboxPrimitive.Root
      open
      filter={filter}
      autoHighlight={autoHighlight}
      {...props}
    />
  )
}

function CommandInput({ className, ...props }: ComboboxPrimitive.Input.Props) {
  return (
    <ComboboxPrimitive.Input
      data-slot="command-input"
      className={cn(className)}
      {...props}
    />
  )
}

function CommandList({ className, ...props }: ComboboxPrimitive.List.Props) {
  return (
    <ComboboxPrimitive.List
      data-slot="command-list"
      className={cn(className)}
      {...props}
    />
  )
}

function CommandGroup({ className, ...props }: ComboboxPrimitive.Group.Props) {
  return (
    <ComboboxPrimitive.Group
      data-slot="command-group"
      className={cn(className)}
      {...props}
    />
  )
}

function CommandGroupLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="command-group-label"
      className={cn(className)}
      {...props}
    />
  )
}

function CommandItem({ className, ...props }: ComboboxPrimitive.Item.Props) {
  return (
    <ComboboxPrimitive.Item
      data-slot="command-item"
      className={cn(className)}
      {...props}
    />
  )
}

/** Stays mounted while the list has results — see the note above. */
function CommandEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props) {
  return (
    <ComboboxPrimitive.Empty
      data-slot="command-empty"
      className={cn(className)}
      {...props}
    />
  )
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
}
