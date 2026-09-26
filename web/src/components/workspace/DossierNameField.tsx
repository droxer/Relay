"use client";

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ActionEdit, ICON } from "../icons";

/** The identity rail's name field: the record's name with a pencil that
 *  swaps it for an inline editor. Shared by the team and project records so
 *  the rail reads — and renames — the same way on both. */
export function DossierNameField({
  label,
  name,
  inputName,
  renameLabel,
  saveLabel,
  disabled = false,
  readOnly = false,
  error,
  onSave,
}: {
  label: string;
  name: string;
  /** The form field name for the inline input. */
  inputName: string;
  renameLabel: string;
  saveLabel: string;
  disabled?: boolean;
  /** An archived or disabled record shows its name without the pencil. */
  readOnly?: boolean;
  error?: string | null;
  /** Resolves true when the rename landed and the editor can close. */
  onSave: (next: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);

  function start() {
    setDraft(name);
    setRenaming(true);
  }

  async function save() {
    const next = draft.trim();
    if (!next) return;
    if (next === name.trim()) {
      setRenaming(false);
      return;
    }
    if (await onSave(next)) setRenaming(false);
  }

  return (
    <div className="workspace-dossier-field">
      <span className="workspace-dossier-field-label">{label}</span>
      {renaming ? (
        <div className="workspace-dossier-rename">
          <Input
            name={inputName}
            type="text"
            aria-label={label}
            autoComplete="off"
            autoFocus
            required
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void save();
              if (event.key === "Escape") setRenaming(false);
            }}
            disabled={disabled}
          />
          {error ? <p role="alert" className="m-0 text-destructive">{error}</p> : null}
          <div className="workspace-dossier-rename-actions">
            <Button type="button" variant="ghost" size="dense" onClick={() => setRenaming(false)} disabled={disabled}>
              {t("dialog.cancel")}
            </Button>
            <Button type="button" size="dense" onClick={() => void save()} disabled={disabled}>
              {saveLabel}
            </Button>
          </div>
        </div>
      ) : (
        <div className="workspace-dossier-name-row">
          <span className="workspace-dossier-name-value" translate="no">{name}</span>
          {readOnly ? null : (
            <Button
              type="button"
              variant="ghost"
              className="workspace-dossier-icon-btn"
              tooltip={renameLabel}
              aria-label={renameLabel}
              onClick={start}
              disabled={disabled}
            >
              <ActionEdit size={ICON.sm} aria-hidden="true" />
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
