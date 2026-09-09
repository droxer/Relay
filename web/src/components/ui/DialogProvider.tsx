"use client";

import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ICON,
  StatusWarn,
} from "../icons";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Toaster, toast } from "@/components/ui/toast";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogDescription,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";

// Promise-based confirm/prompt that replaces the native window.confirm /
// window.prompt. Those drop unstyled OS chrome into a token-driven product
// and can't carry the danger-tone treatment the design system defines. This
// keeps call sites nearly identical — `if (!(await confirm({...}))) return;` —
// while rendering an in-brand modal.

type ConfirmOptions = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** "danger" routes the confirm action to the destructive button variant. */
  tone?: "default" | "danger";
};

type PromptOptions = {
  title: string;
  message?: string;
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
};

type AnnouncementTone = "info" | "success" | "warn" | "error";

type AnnouncementOptions = {
  message: string;
  tone?: AnnouncementTone;
};

type Request =
  | { kind: "confirm"; opts: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: "prompt"; opts: PromptOptions; resolve: (value: string | null) => void };

interface DialogApi {
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
  prompt: (opts: PromptOptions) => Promise<string | null>;
  announce: (opts: AnnouncementOptions | string) => void;
}

const DialogContext = createContext<DialogApi | null>(null);

/* Announcements go through the shadcn/ui toast (base-ui Toast): the manager
   queues, stacks, pauses on hover, and announces to screen readers on its
   own. The 6s dwell matches the hand-rolled toast this replaced. */
const TOAST_VISIBLE_MS = 6000;

export function useDialogs(): DialogApi {
  const ctx = useContext(DialogContext);
  if (!ctx) throw new Error("useDialogs must be used within <DialogProvider>");
  return ctx;
}

export function DialogProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<Request | null>(null);
  const [dialogClosing, setDialogClosing] = useState(false);
  const [inputValue, setInputValue] = useState("");
  const requestRef = useRef<Request | null>(null);
  const requestQueue = useRef<Request[]>([]);
  const dialogClosingRef = useRef(false);
  /* Where focus lands when the modal opens: the prompt's field, the cancel
     button on a destructive confirm, the confirm button otherwise. This used
     to be a `[data-modal-initial-focus]` attribute the modal hook went
     looking for; the primitive takes the element directly. */
  const initialFocusRef = useRef<HTMLElement | null>(null);

  const enqueueRequest = useCallback((next: Request) => {
    if (requestRef.current) {
      requestQueue.current.push(next);
      return;
    }
    requestRef.current = next;
    setRequest(next);
    setInputValue(next?.kind === "prompt" ? next.opts.defaultValue ?? "" : "");
  }, []);

  const confirm = useCallback(
    (opts: ConfirmOptions) =>
      new Promise<boolean>((resolve) => enqueueRequest({ kind: "confirm", opts, resolve })),
    [enqueueRequest],
  );

  const prompt = useCallback(
    (opts: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        enqueueRequest({ kind: "prompt", opts, resolve });
      }),
    [enqueueRequest],
  );

  const announce = useCallback((opts: AnnouncementOptions | string) => {
    const next = typeof opts === "string" ? { message: opts } : opts;
    // The shadcn toast names the warn tone "warning".
    toast.add({ title: next.message, type: next.tone === "warn" ? "warning" : (next.tone ?? "info") });
  }, []);

  // Resolve the pending promise and tear down. `cancelled` carries the
  // negative result (false / null); a positive result passes the value.
  const settle = useCallback((result: boolean | string | null) => {
    const current = requestRef.current;
    if (!current || dialogClosingRef.current) return;
    if (current.kind === "confirm") current.resolve(result === true);
    else current.resolve(typeof result === "string" ? result : null);

    // Start the exit; `handleClosed` below picks up the next queued request
    // once the animation has actually finished. This used to be a setTimeout
    // measured off the panel's computed animation duration.
    dialogClosingRef.current = true;
    setDialogClosing(true);
  }, []);

  const handleClosed = useCallback(() => {
    const next = requestQueue.current.shift() ?? null;
    requestRef.current = next;
    setRequest(next);
    setInputValue(next?.kind === "prompt" ? next.opts.defaultValue ?? "" : "");
    dialogClosingRef.current = false;
    setDialogClosing(false);
  }, []);

  const cancelValue = (req: Request): boolean | null => (req.kind === "confirm" ? false : null);

  const dialogOpen = Boolean(request);

  // Escape settles with the request's cancel value (false / null, the same as
  // the cancel button); everything else about the modal contract — the focus
  // trap, focus restore, the scroll lock, holding the panel for its exit
  // animation — comes from the Dialog primitive.
  const dismissDialog = useCallback(() => {
    const current = requestRef.current;
    if (current) settle(cancelValue(current));
  }, [settle]);

  const attachPromptInput = useCallback((node: HTMLInputElement | null) => {
    initialFocusRef.current = node;
  }, []);

  const isDangerConfirm = request?.kind === "confirm" && request.opts.tone === "danger";
  return (
    <DialogContext.Provider value={{ confirm, prompt, announce }}>
      {children}
      <Toaster timeout={TOAST_VISIBLE_MS} />
      <Dialog
        open={dialogOpen && !dialogClosing}
        onOpenChange={(next) => {
          if (!next) dismissDialog();
        }}
        onOpenChangeComplete={(next) => {
          if (!next) handleClosed();
        }}
      >
        {request ? (
          <DialogPortal>
            <DialogBackdrop className="dialog-backdrop" />
            <DialogViewport className="dialog-viewport">
              <DialogContent
                role={request.kind === "prompt" ? "dialog" : "alertdialog"}
                aria-labelledby="dialog-title"
                aria-describedby={request.opts.message ? "dialog-desc" : undefined}
                className="dialog-modal"
                data-tone={isDangerConfirm ? "danger" : undefined}
                initialFocus={initialFocusRef}
              >
                <div className="dialog-title-row">
                  {isDangerConfirm ? (
                    <StatusWarn size={ICON.lg} className="dialog-danger-icon" aria-hidden="true" />
                  ) : null}
                  <DialogTitle id="dialog-title" className="dialog-title" translate="no" render={<h2 />}>
                    {request.opts.title}
                  </DialogTitle>
                </div>
                {request.opts.message ? (
                  <DialogDescription id="dialog-desc" className="dialog-message" render={<p />}>
                    {request.opts.message}
                  </DialogDescription>
                ) : null}

                {request.kind === "prompt" ? (
                  <form
                    className="dialog-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      settle(inputValue.trim());
                    }}
                  >
                    <Input
                      /* window.prompt parity: the default arrives selected, so
                         typing replaces it rather than appending to it. */
                      ref={attachPromptInput}
                      // Wait for Dialog to capture the opener before selection
                      // focuses the field, so closing can restore focus.
                      onFocus={(event) => event.currentTarget.select()}
                      className="dialog-input"
                      name="dialog-prompt"
                      autoComplete="off"
                      aria-labelledby="dialog-title"
                      value={inputValue}
                      placeholder={request.opts.placeholder}
                      onChange={(event) => setInputValue(event.target.value)}
                    />
                  </form>
                ) : null}

                {/* Ghost cancel + primary confirm at `cta` — the same footer
                    recipe every drawer uses (adm-form-actions). A dialog and a
                    drawer ask the identical question, so the dismiss action
                    must not sit in a different tier in each. */}
                <div className="dialog-actions">
                  <Button
                    type="button"
                    variant="ghost"
                    size="cta"
                    ref={isDangerConfirm ? (node) => { initialFocusRef.current = node; } : undefined}
                    disabled={dialogClosing}
                    onClick={() => settle(cancelValue(request))}
                  >
                    {request.opts.cancelLabel ?? t("dialog.cancel")}
                  </Button>
                  {request.kind === "confirm" ? (
                    <Button
                      type="button"
                      size="cta"
                      variant={request.opts.tone === "danger" ? "destructive" : "default"}
                      ref={isDangerConfirm ? undefined : (node) => { initialFocusRef.current = node; }}
                      disabled={dialogClosing}
                      onClick={() => settle(true)}
                    >
                      {request.opts.confirmLabel ?? t("dialog.confirm")}
                    </Button>
                  ) : (
                    <Button type="button" size="cta" disabled={dialogClosing} onClick={() => settle(inputValue.trim())}>
                      {request.opts.confirmLabel ?? t("dialog.confirm")}
                    </Button>
                  )}
                </div>
              </DialogContent>
            </DialogViewport>
          </DialogPortal>
        ) : null}
      </Dialog>
    </DialogContext.Provider>
  );
}
