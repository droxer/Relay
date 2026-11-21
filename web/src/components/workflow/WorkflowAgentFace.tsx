"use client";

import { IdentityMark } from "../IdentityMark";
import { ProfileImage } from "../ProfileImagePicker";

/** The Agent who owns a workflow step, drawn as its profile image — the
 *  default Agent mark when it has none. Decorative: the owner's name is always
 *  written beside it. */
export function WorkflowAgentFace({ imageUrl }: { imageUrl?: string | null }) {
  return (
    <span className="workflow-agent-face" aria-hidden="true">
      <ProfileImage src={imageUrl} alt="" fallback={<IdentityMark kind="agent" />} />
    </span>
  );
}
