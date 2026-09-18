"use client";

import { useTranslation } from "react-i18next";

import { ICON, NavBack } from "../icons";
import { Button } from "@/components/ui/button";

/** Back out of an open file, to the list it was picked from.
 *
 *  Icon-only, with the action as its accessible name and the file's name
 *  rendered beside it rather than inside it. The arrow used to wrap the
 *  filename, which made a control whose spoken name was a filename and whose
 *  job — going back — was carried by a glyph; it also meant the longest thing
 *  in the row was the thing that had to stay clickable.
 *
 *  It lives in the FILE's header row on every surface. The panel header above
 *  it keeps only the panel's own name and its close button, so the two rows
 *  no longer present what looked like a pair of back controls.
 */
export function FilePaneBack({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      variant="ghost"
      size="icon-dense"
      type="button"
      className="file-pane-back"
      tooltip={t("workspace.back_to_files")}
      onClick={onClick}
    >
      <NavBack size={ICON.sm} aria-hidden="true" />
    </Button>
  );
}
