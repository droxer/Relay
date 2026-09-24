"use client"

import { useId, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { enUS, zhCN, zhTW } from "react-day-picker/locale"

import { cn } from "@/lib/utils"
import { dateFromKey } from "@/lib/dateKey"
import { isoToday } from "@/lib/routine"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ActionCalendar, ActionRemove, ICON } from "@/components/icons"

const DAY_PICKER_LOCALES = { en: enUS, "zh-CN": zhCN, "zh-TW": zhTW } as const

function formatDay(date: Date, language: string): string {
  return new Intl.DateTimeFormat(language, { year: "numeric", month: "short", day: "numeric" }).format(date)
}

/* A single calendar day, entered from a calendar popover.

   The value is a day key ("2026-07-19"), "" when empty — the same string the
   native date input produced, so form state and the API are unchanged.

   Pair it with <Field wrapper="div" labelId={id}> and pass the same id as
   `labelId`: the trigger is named by the field label AND the chosen day
   ("Due Sep 14, 2026"). An implicit <label> is not enough — Chrome names a
   button from its content once it has any, which dropped the field name.

   A native input is kept, visually hidden, because it is what carries the
   `required` constraint: an empty custom run date still stops the form from
   submitting, exactly as the old date input did. It is out of the tab order,
   and if the browser focuses it to report the error, focus moves to the
   trigger the reader can act on. */
function DatePicker({
  labelId,
  name,
  value,
  onValueChange,
  min,
  required = false,
  readOnly = false,
  className,
}: {
  /** The id of the field's label element. */
  labelId: string
  name: string
  value: string
  onValueChange: (value: string) => void
  /** Earliest selectable day key; earlier days are disabled. */
  min?: string
  required?: boolean
  /** Shown but not editable — e.g. a next run computed from the cadence. */
  readOnly?: boolean
  className?: string
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const valueId = useId()
  const selected = dateFromKey(value)
  const earliest = min ? dateFromKey(min) : undefined
  const locale = DAY_PICKER_LOCALES[i18n.language as keyof typeof DAY_PICKER_LOCALES] ?? enUS
  const canClear = Boolean(value) && !required && !readOnly

  return (
    <div className={cn("relative flex w-full items-center", className)} data-slot="date-picker">
      <Popover open={open && !readOnly} onOpenChange={(next) => setOpen(readOnly ? false : next)}>
        <PopoverTrigger
          ref={triggerRef}
          aria-labelledby={`${labelId} ${valueId}`}
          aria-disabled={readOnly || undefined}
          data-readonly={readOnly || undefined}
          className={cn(
            "flex h-(--control-h) w-full min-w-0 items-center gap-2 rounded-md border border-input bg-background px-3 text-start text-md text-foreground transition-[border-color]",
            "data-readonly:cursor-default data-readonly:text-muted-foreground",
            canClear && "pe-9"
          )}
        >
          <ActionCalendar size={ICON.sm} aria-hidden="true" className="shrink-0 text-muted-foreground" />
          <span id={valueId} className={cn("truncate", !selected && "text-muted-foreground")}>
            {selected ? formatDay(selected, i18n.language) : t("date_picker.placeholder")}
          </span>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-auto p-0">
          <Calendar
            mode="single"
            locale={locale}
            selected={selected}
            defaultMonth={selected ?? earliest}
            disabled={earliest ? { before: earliest } : undefined}
            autoFocus
            onSelect={(date) => {
              onValueChange(date ? isoToday(date) : "")
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
      {canClear ? (
        <button
          type="button"
          className="absolute end-1 inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
          aria-label={t("date_picker.clear")}
          onClick={() => {
            onValueChange("")
            triggerRef.current?.focus()
          }}
        >
          <ActionRemove size={ICON.sm} aria-hidden="true" />
        </button>
      ) : null}
      <input
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        name={name}
        value={value}
        required={required}
        onChange={() => {}}
        onFocus={() => triggerRef.current?.focus()}
      />
    </div>
  )
}

export { DatePicker }
