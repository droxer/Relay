"use client";

import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { isRenderableFile } from "../../lib/fileKinds";
import { ArtifactViewToggle, type ArtifactView } from "../artifact/ArtifactViewToggle";
import { canDownloadWorkspaceFile, downloadWorkspaceFile } from "./workspaceDownload";
import { Button } from "@/components/ui/button";
import { useDialogs } from "@/components/ui/DialogProvider";

type WorkspaceFileData = {
  content?: string | null;
  contentBase64?: string | null;
  isBinary?: boolean;
  truncated?: boolean;
};

/** What you can DO with the open workspace file: switch reading, save it.
 *
 *  One component because the file opens on two surfaces — the full-page
 *  preview pane and the thread space panel — and the controls used to disagree
 *  on all three counts: the panel put its switch in the panel header while the
 *  page put it in the body, the two spelled the same switch "Preview/Source"
 *  and "Rendered/Source", and only the artifact path offered a download at
 *  all. Both surfaces now mount this in their file header, beside the name.
 *
 *  A truncated response offers no download at all rather than a disabled
 *  control: the bytes on screen are not the file, and the body is already
 *  saying so (workspace.file_truncated). A disabled button would need its
 *  reason in a tooltip, which a disabled element does not reliably show.
 */
export function WorkspaceFileActions({
  name,
  data,
  view,
  onViewChange,
}: {
  name: string;
  data?: WorkspaceFileData;
  view: ArtifactView;
  onViewChange: (view: ArtifactView) => void;
}) {
  const { t } = useTranslation();
  const { announce } = useDialogs();

  const handleDownload = useCallback(() => {
    if (!data) return;
    try {
      downloadWorkspaceFile(name, data);
    } catch {
      announce({ message: t("workspace.download_failed"), tone: "error" });
    }
  }, [announce, data, name, t]);

  return (
    <>
      {isRenderableFile(name) ? (
        <ArtifactViewToggle view={view} onChange={onViewChange} />
      ) : null}
      {canDownloadWorkspaceFile(data) ? (
        <Button variant="ghost" size="dense" type="button" onClick={handleDownload}>
          {t("artifact.action_download")}
        </Button>
      ) : null}
    </>
  );
}
