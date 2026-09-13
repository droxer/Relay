import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import { Label } from "@/components/ui/label"

/* Field — the label/control/hint/error stack that every drawer form built by
   hand around `.adm-field`. Replaces both the `.adm-field > span` descendant
   selector (which styled label text without a component, so it only worked
   inside that exact parent) and the repeated error-text markup.

   The wrapper stays a real `<label>`, so the control inside is implicitly
   associated and no call site has to invent an id. That is also why the label
   text renders as a `<span>`: a nested `<label>` would be invalid HTML.

   Callers still own `aria-invalid` / `aria-describedby` on the control itself —
   the id is threaded through `errorId` so the two sides cannot drift. */

function Field({
  label,
  labelId,
  htmlFor,
  required = false,
  optional,
  hint,
  error,
  errorId,
  disabled = false,
  wrapper = "label",
  className,
  children,
}: {
  label: ReactNode
  /** Set when a `wrapper="div"` control points at the label via
   *  aria-labelledby — a Select trigger has no implicit association. */
  labelId?: string
  /** With `wrapper="div"`, promotes the label text to a real <label htmlFor>
   *  bound to this control id — the explicit association, preferred over
   *  `labelId` + aria-labelledby whenever the control exposes an id. */
  htmlFor?: string
  /** Renders the required marker. Decorative — the control keeps `required`. */
  required?: boolean
  /** Copy for the optional marker, e.g. t("admin.v2.optional"). */
  optional?: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** Must match the control's aria-describedby when `error` is present. */
  errorId?: string
  disabled?: boolean
  /** `div` for controls a <label> cannot wrap — a Select trigger, a switch row,
   *  a nested fieldset. Those keep their own aria-label on the control. */
  wrapper?: "label" | "div"
  className?: string
  children: ReactNode
}) {
  const Wrapper = wrapper
  return (
    <Wrapper
      data-slot="field"
      data-disabled={disabled || undefined}
      className={cn("group/field flex min-w-0 flex-col gap-1.5", className)}
    >
      {/* A nested <label> would be invalid, so the label text is a <span> unless
          the wrapper is a <div> and an explicit htmlFor target was given. */}
      <Label
        render={
          wrapper === "div" && htmlFor ? (
            <label htmlFor={htmlFor} id={labelId} />
          ) : (
            <span id={labelId} />
          )
        }
      >
        {label}
        {required ? (
          <span className="font-medium text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
        {optional ? (
          <span className="text-micro font-medium tracking-(--track-caps) text-muted-foreground uppercase">
            {optional}
          </span>
        ) : null}
      </Label>
      {children}
      {hint ? (
        <p className="m-0 text-xs leading-normal text-muted-foreground">{hint}</p>
      ) : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Wrapper>
  )
}

/* The field-level error treatment, on its own so controls <Field> cannot wrap
   can still use it. A fieldset of checkboxes (TeamDrawer's member picker) or a
   custom radio list (AssignNodeDrawer's node list) owns its own layout but
   still needs the one error voice — previously each hand-copied this span, so
   the treatment lived in three places.

   Distinct from `.adm-form-error`, which is the boxed SUBMIT-level error at the
   foot of a drawer form. Field errors sit inline under their control. */
function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <span id={id} role="alert" className="text-sm text-danger">
      {children}
    </span>
  )
}

export { Field, FieldError }
