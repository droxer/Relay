"use client"

import type { SVGProps } from "react"
import { REUI_GLYPHS } from "@/components/icons"

/* Stands in for ReUI's own `IconPlaceholder`, which lives in ReUI's site
   (`@/app/(create)/…`) and picks among five icon libraries. Relay uses one:
   the lucide name resolves through REUI_GLYPHS, so every glyph a vendored
   component draws carries the product's standard stroke. The other library
   names are accepted and ignored so vendored call sites stay untouched. */
type ReuiGlyphName = keyof typeof REUI_GLYPHS

export function IconPlaceholder({
  lucide,
  tabler: _tabler,
  hugeicons: _hugeicons,
  phosphor: _phosphor,
  remixicon: _remixicon,
  ...props
}: SVGProps<SVGSVGElement> & {
  lucide: string
  tabler?: string
  hugeicons?: string
  phosphor?: string
  remixicon?: string
}) {
  const Glyph = REUI_GLYPHS[lucide as ReuiGlyphName]
  if (!Glyph) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[reui] no Relay glyph mapped for lucide "${lucide}" — add it to REUI_GLYPHS`)
    }
    return null
  }
  return <Glyph {...(props as object)} />
}
