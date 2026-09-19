"use client";

import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogPortal,
  DialogTitle,
  DialogViewport,
} from "@/components/ui/dialog";
import { commandShortcutLabel } from "@/lib/shortcuts";
import { sendShortcutLabel } from "@/lib/sendShortcut";

/* The `?` overlay — the discoverable registry of every global chord. Linear
   ships the same dialog; the rule is that any shortcut added to
   lib/shortcuts.ts gets a row here, or it effectively does not exist. */

type ShortcutRow = { keys: string; labelKey: string; adminOnly?: boolean };

const GLOBAL_ROWS: ShortcutRow[] = [
  { keys: "command", labelKey: "shortcuts.open_command" },
  { keys: "?", labelKey: "shortcuts.show_help" },
  { keys: "C", labelKey: "shortcuts.new_task" },
  { keys: "N", labelKey: "shortcuts.new_thread" },
];

const NAVIGATE_ROWS: ShortcutRow[] = [
  { keys: "G T", labelKey: "nav.threads" },
  { keys: "G P", labelKey: "project.projects" },
  { keys: "G B", labelKey: "nav.backlog" },
  { keys: "G R", labelKey: "nav.routine" },
  { keys: "G A", labelKey: "nav.agents" },
  { keys: "G E", labelKey: "nav.teams" },
  { keys: "G H", labelKey: "nav.channels" },
  { keys: "G S", labelKey: "nav.settings" },
  { keys: "G D", labelKey: "nav.admin", adminOnly: true },
];

function ShortcutRowView({ keys, label }: { keys: string; label: string }) {
  return (
    <li className="shortcuts-row">
      <span className="shortcuts-row-label">{label}</span>
      <kbd className="command-kbd">{keys}</kbd>
    </li>
  );
}

export function ShortcutsHelp({
  open,
  isAdmin,
  onClose,
}: {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  /* `?` closes this the way it opened it. Escape, the focus trap, focus
     restore, and the scroll lock come from the Dialog primitive — this panel
     used to do all four by hand and only ever managed three: it focused the
     panel but never trapped Tab, so a keyboard user could walk out of an
     open modal into the page behind it. */
  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "?") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPortal>
        <DialogBackdrop className="command-backdrop" />
        <DialogViewport className="command-viewport">
          <DialogContent
            className="command-menu shortcuts-panel"
            aria-label={t("shortcuts.title")}
          >
            <DialogTitle className="shortcuts-title" render={<h2 />}>
              {t("shortcuts.title")}
            </DialogTitle>
            <div className="shortcuts-columns">
              <section className="shortcuts-group" aria-label={t("shortcuts.group_global")}>
                <h3 className="command-group-label">{t("shortcuts.group_global")}</h3>
                <ul className="shortcuts-list">
                  {GLOBAL_ROWS.map((row) => (
                    <ShortcutRowView
                      key={row.labelKey}
                      keys={row.keys === "command" ? commandShortcutLabel() : row.keys}
                      label={t(row.labelKey)}
                    />
                  ))}
                </ul>
              </section>
              <section className="shortcuts-group" aria-label={t("shortcuts.group_navigate")}>
                <h3 className="command-group-label">{t("shortcuts.group_navigate")}</h3>
                <ul className="shortcuts-list">
                  {NAVIGATE_ROWS.filter((row) => !row.adminOnly || isAdmin).map((row) => (
                    <ShortcutRowView key={row.labelKey} keys={row.keys} label={t(row.labelKey)} />
                  ))}
                </ul>
              </section>
              <section className="shortcuts-group" aria-label={t("shortcuts.group_composer")}>
                <h3 className="command-group-label">{t("shortcuts.group_composer")}</h3>
                <ul className="shortcuts-list">
                  <ShortcutRowView keys={sendShortcutLabel()} label={t("shortcuts.send_message")} />
                </ul>
              </section>
            </div>
          </DialogContent>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
