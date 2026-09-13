"use client";

import { useTranslation } from "react-i18next";
import { RelayEmptyState } from "../RelayEmptyState";
import { Badge } from "@/components/ui/badge";

/* The specimen rows preview real artifact kinds so the ghost list reads as
   a promise, not decoration — labels come from the shared kind i18n table. */
const GHOST_KINDS = ["plan", "review", "summary"] as const;

/** Empty state for an artifacts browse pane: the shared `RelayEmptyState`,
 *  with three dashed ghost rows in the illustration slot that mirror the
 *  anatomy of `.workspace-pick` artifact rows (kind tag · title bar · time
 *  slot) and fade out downward. */
export function ArtifactsEmpty({ title, hint }: { title: string; hint?: string }) {
  const { t } = useTranslation();
  return (
    <RelayEmptyState
      className="relay-empty--artifacts"
      title={title}
      hint={hint}
      illustration={(
        <ul className="artifacts-empty-ghosts">
          {GHOST_KINDS.map((kind) => (
            <li key={kind} className="artifacts-empty-ghost">
              <Badge variant="state" className="artifacts-empty-tag">{t(`artifact.kind.${kind}`)}</Badge>
              <span className="artifacts-empty-line" />
              <span className="artifacts-empty-date tnum">··:··</span>
            </li>
          ))}
        </ul>
      )}
    />
  );
}
