import type { ComponentProps } from "react"

import { ActionSearch } from "@/components/icons"

/* SearchInput — the icon + type="search" row that every list filter used to
   assemble by hand. Owns the structure and the standard input attributes
   (type, autoComplete, spellCheck, aria-label); the caller keeps its wrapper
   class, so each surface (bordered box, panel header, dense roster row) keeps
   its own chrome while the markup and a11y contract stay in one place. */
function SearchInput({
  className,
  inputClassName,
  iconSize = 16,
  label,
  ...props
}: ComponentProps<"input"> & {
  /** Extra class on the <input> itself — most wrappers style it via descendant. */
  inputClassName?: string
  iconSize?: number
  /** Accessible name; also the right value for `placeholder`. */
  label: string
}) {
  return (
    <div data-slot="search" className={className}>
      <ActionSearch size={iconSize} aria-hidden="true" />
      <input
        type="search"
        autoComplete="off"
        spellCheck={false}
        aria-label={label}
        className={inputClassName}
        {...props}
      />
    </div>
  )
}

export { SearchInput }
