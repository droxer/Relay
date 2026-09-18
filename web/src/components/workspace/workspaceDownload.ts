/** Saving a workspace file to disk.
 *
 *  There is no raw/download route for a workspace file — the API returns the
 *  bytes as JSON (`content`, or `contentBase64` when binary), so the only
 *  honest way to hand the reader a file is to rebuild it from what the preview
 *  already fetched. That is also why `canDownloadWorkspaceFile` refuses a
 *  truncated response: the bytes on screen are not the file, and a download
 *  that silently writes a cut-off document is worse than no download.
 */

type WorkspaceFileBytes = {
  content?: string | null;
  contentBase64?: string | null;
  isBinary?: boolean;
  truncated?: boolean;
};

export function canDownloadWorkspaceFile(data: WorkspaceFileBytes | undefined): boolean {
  if (!data || data.truncated) return false;
  return data.isBinary ? Boolean(data.contentBase64) : typeof data.content === "string";
}

function blobFor(data: WorkspaceFileBytes): Blob {
  if (data.isBinary && data.contentBase64) {
    const binary = atob(data.contentBase64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return new Blob([bytes], { type: "application/octet-stream" });
  }
  return new Blob([data.content ?? ""], { type: "text/plain;charset=utf-8" });
}

/** Writes the file to the reader's downloads. Throws on a malformed payload
 *  (bad base64) so the caller can surface it rather than doing nothing. */
export function downloadWorkspaceFile(name: string, data: WorkspaceFileBytes): void {
  const url = URL.createObjectURL(blobFor(data));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoking in the same task can cancel the write in some browsers; give the
  // navigation a turn of the loop first.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
