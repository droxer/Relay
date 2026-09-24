"use client"

import type { ComponentProps } from "react"
import { useTranslation } from "react-i18next"

import { cn } from "@/lib/utils"
import { REUI_GLYPHS } from "@/components/icons"

const LoaderGlyph = REUI_GLYPHS.LoaderCircleIcon

function Spinner({ className, ...props }: ComponentProps<"svg">) {
  const { t } = useTranslation()
  return (
    <LoaderGlyph
      data-slot="spinner"
      role="status"
      aria-hidden={undefined}
      aria-label={t("spinner.loading")}
      className={cn("size-4 animate-spin motion-reduce:animate-none", className)}
      {...props}
    />
  )
}

export { Spinner }
