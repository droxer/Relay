"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { filterCommands, type CommandGroup, type CommandId, type CommandItem } from "@/lib/commandMenu";
import {
  ActionSearch,
  ICON,
} from "./icons";
import {
  Command,
  CommandEmpty,
  CommandGroup as CommandGroupPart,
  CommandGroupLabel,
  CommandInput,
  CommandItem as CommandItemPart,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogBackdrop,
  DialogContent,
  DialogPortal,
  DialogViewport,
} from "@/components/ui/dialog";

/* ⌘K command palette — Linear-style. A thin renderer over lib/commandMenu.ts:
   the catalogue and ranking live there, the Dialog owns focus and the scrim,
   and the Combobox owns the listbox contract.

   What this file no longer does, because the primitive does it: the roving
   highlight and its wraparound, Home/End, `aria-activedescendant`, the
   `aria-controls`/`aria-expanded` pair, the option roles, and the
   scroll-the-highlight-into-view effect. Those were ~50 lines of correct but
   generic code; what is left below is the parts that are actually about
   commands — the ranking call, and the group headers. */

const GROUP_LABEL_KEYS: Record<CommandGroup, string> = {
  navigate: "command.group_navigate",
  create: "command.group_create",
  view: "command.group_view",
};

export function CommandMenu({
  open,
  commands,
  onRun,
  onClose,
}: {
  open: boolean;
  commands: CommandItem[];
  onRun: (id: CommandId) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(() => filterCommands(commands, query), [commands, query]);

  /* Group headers divide the flat RANKED list without disturbing its order: a
     group opens where the group changes between adjacent items, so a command
     that ranks first still appears first even if its group does not. That is
     why this builds runs out of the ordered list rather than bucketing by
     group — bucketing would sort the ranking away. */
  const groups = useMemo(() => {
    const out: { group: CommandGroup; items: CommandItem[] }[] = [];
    for (const command of visible) {
      const last = out[out.length - 1];
      if (last && last.group === command.group) last.items.push(command);
      else out.push({ group: command.group, items: [command] });
    }
    return out;
  }, [visible]);

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
            className="command-menu"
            initialFocus={inputRef}
            aria-label={t("command.title")}
          >
            {/* `value` is never held: picking a command runs it and closes the
                palette, so there is no selection to keep. The item value is
                the command id, which is what `onValueChange` hands back. */}
            <Command<CommandId | null>
              items={groups}
              value={null}
              onValueChange={(id) => {
                if (!id) return;
                onClose();
                onRun(id);
              }}
              inputValue={query}
              onInputValueChange={setQuery}
              /* Escape (and an outside press) should dismiss the whole
                 surface, not just the list — the list IS the surface here.
                 Picking an item is excluded because `onValueChange` above has
                 already closed: without the guard a keyboard run closes the
                 palette twice, once per path. */
              onOpenChange={(next, details) => {
                if (next || details.reason === "item-press") return;
                onClose();
              }}
            >
              <div className="command-input-row">
                <ActionSearch size={ICON.sm} aria-hidden="true" />
                <CommandInput
                  ref={inputRef}
                  className="command-input"
                  name="command-query"
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t("command.title")}
                  placeholder={t("command.placeholder")}
                />
              </div>
              <CommandEmpty className="command-empty">
                {visible.length === 0 ? t("command.empty") : null}
              </CommandEmpty>
              <CommandList className="command-list">
                {groups.map((group, i) => (
                  <CommandGroupPart key={`${group.group}-${i}`} items={group.items}>
                    <CommandGroupLabel className="command-group-label">
                      {t(GROUP_LABEL_KEYS[group.group])}
                    </CommandGroupLabel>
                    {group.items.map((command) => (
                      <CommandItemPart
                        key={command.id}
                        value={command.id}
                        className="command-item"
                      >
                        <span className="command-item-label">{command.label}</span>
                        {command.hint ? (
                          <kbd className="command-kbd" aria-hidden="true">{command.hint}</kbd>
                        ) : null}
                      </CommandItemPart>
                    ))}
                  </CommandGroupPart>
                ))}
              </CommandList>
            </Command>
            <div className="command-footer" aria-hidden="true">
              <span className="command-footer-hint"><kbd className="command-kbd">↑↓</kbd> {t("command.hint_navigate")}</span>
              <span className="command-footer-hint"><kbd className="command-kbd">↵</kbd> {t("command.hint_run")}</span>
              <span className="command-footer-hint"><kbd className="command-kbd">esc</kbd> {t("command.hint_close")}</span>
            </div>
          </DialogContent>
        </DialogViewport>
      </DialogPortal>
    </Dialog>
  );
}
