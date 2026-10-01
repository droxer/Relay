import { useState, useCallback, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { RelayArtifact } from "relay-core";
import {
  ActionSearch,
  ArtifactCommand,
  ArtifactDiff,
  ArtifactFile,
  ArtifactFileCode,
  ArtifactFileImage,
  ArtifactFileTable,
  ArtifactOutput,
  ArtifactPlan,
  ArtifactReview,
  ArtifactSummary,
  ArtifactTest,
  ICON,
} from "../icons";
import { filterArtifacts } from "../../lib/artifactFilters";
import { artifactFileName, artifactShowsKind, formatArtifactDate } from "../../lib/artifactPreview";
import { extensionOf, imageMimeForFile, isMarkdownFile, languageForFile } from "../../lib/fileKinds";
import { Button } from "@/components/ui/button";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { SearchInput } from "@/components/ui/search-input";
export { filterArtifacts } from "../../lib/artifactFilters";

const TABLE_EXTENSIONS: ReadonlySet<string> = new Set(["csv", "tsv", "xls", "xlsx"]);

/** The produced-file glyph for a file name: picture, source, table, or the
 *  plain sheet (Markdown and everything unrecognised). */
function WorkspaceFileIcon({ name, size }: { name: string; size: number }) {
  if (imageMimeForFile(name)) return <ArtifactFileImage size={size} />;
  if (TABLE_EXTENSIONS.has(extensionOf(name))) return <ArtifactFileTable size={size} />;
  if (!isMarkdownFile(name) && languageForFile(name)) return <ArtifactFileCode size={size} />;
  return <ArtifactFile size={size} />;
}

export function ArtifactKindIcon({ kind, size, name }: {
  kind: RelayArtifact["kind"];
  size: number;
  /** A workspace file's name, which picks its family's glyph. */
  name?: string;
}) {
  switch (kind) {
    case "plan":
      return <ArtifactPlan size={size} />;
    case "diff":
      return <ArtifactDiff size={size} />;
    case "review":
      return <ArtifactReview size={size} />;
    case "test_output":
      return <ArtifactTest size={size} />;
    case "command_log":
      return <ArtifactCommand size={size} />;
    case "summary":
      return <ArtifactSummary size={size} />;
    case "agent_output":
      return <ArtifactOutput size={size} />;
    case "workspace_file":
      return name ? <WorkspaceFileIcon name={name} size={size} /> : <ArtifactFile size={size} />;
  }
}

export function ArtifactIndexStrip({
  artifacts,
  selectedId,
  onSelect,
  expanded,
  onExpandedChange,
}: {
  artifacts: RelayArtifact[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  expanded: boolean;
  onExpandedChange: (v: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const [query, setQuery] = useState("");
  const [kindFilter, setKindFilter] = useState<RelayArtifact["kind"] | "all">("all");

  const kinds = Array.from(new Set(artifacts.map((a) => a.kind)));
  const filtered = filterArtifacts(artifacts, query, kindFilter);

  /* Opens on the search button only, never on hover or focus: the panel
     slides over the preview, and a pointer crossing a 48px rail on its way to
     the document should not cover the document. Leaving the strip by keyboard
     or Escape puts it away again. */
  const handleBlur = useCallback(
    (event: React.FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onExpandedChange(false);
    },
    [onExpandedChange],
  );
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLElement>) => {
      if (event.key !== "Escape" || !expanded) return;
      // Close the panel, not the drawer around it.
      event.stopPropagation();
      onExpandedChange(false);
    },
    [expanded, onExpandedChange],
  );

  /* Title plus creation time: with "all versions" on, one file appears several
     times under the same title, and the stamp is what tells them apart. */
  const describe = (a: RelayArtifact) => {
    const date = formatArtifactDate(a.createdAt, i18n.language);
    return date ? `${a.title} · ${date}` : a.title;
  };

  return (
    <nav
      className={`artifact-index-strip${expanded ? " is-expanded" : ""}`}
      aria-label={t("artifact.strip_label")}
      onBlur={handleBlur}
      onKeyDown={handleKeyDown}
    >
      {/* Collapsed: icon buttons only */}
      <div className="artifact-index-strip-icons">
        <Button variant="ghost"
          type="button"
          className={`artifact-index-btn${expanded ? " is-active" : ""}`}
          tooltip={t("artifact.search_label")}
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
        >
          <ActionSearch size={ICON.md} />
        </Button>
        {artifacts.map((a) => (
          <Button variant="ghost"
            key={a.id}
            type="button"
            className={`artifact-index-btn${a.id === selectedId ? " is-active" : ""}`}
            data-kind={a.kind}
            tooltip={describe(a)}
            aria-current={a.id === selectedId || undefined}
            onClick={() => onSelect(a.id)}
          >
            <ArtifactKindIcon kind={a.kind} size={ICON.md} name={artifactFileName(a)} />
          </Button>
        ))}
      </div>

      {/* Expanded: full list panel */}
      <div className="artifact-index-panel">
        <SearchInput
          className="artifact-index-search"
          iconSize={ICON.sm}
          label={t("artifact.search_label")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("artifact.search_placeholder")}
        />
        {kinds.length > 1 ? (
          /* One active filter at a time — a toggle group, the shared control
             for "which subset is on screen". */
          <ToggleGroup
            className="artifact-index-filters"
            aria-label={t("artifact.filter_label")}
            value={[kindFilter]}
            onValueChange={(next) => {
              const picked = next[0];
              if (picked) setKindFilter(picked as RelayArtifact["kind"] | "all");
            }}
          >
            <ToggleGroupItem value="all" className="artifact-index-filter-btn">
              {t("artifact.filter_all")}
            </ToggleGroupItem>
            {kinds.map((k) => (
              <ToggleGroupItem key={k} value={k} className="artifact-index-filter-btn">
                {t(`artifact.kind.${k}`, { defaultValue: k })}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        ) : null}
        <div className="artifact-index-list">
          {filtered.length === 0 ? (
            <p className="artifact-index-empty">{t("artifact.no_matches")}</p>
          ) : (
            filtered.map((a) => (
              <Button variant="ghost"
                key={a.id}
                type="button"
                className={`artifact-index-row${a.id === selectedId ? " is-active" : ""}`}
                data-kind={a.kind}
                aria-current={a.id === selectedId || undefined}
                onClick={() => onSelect(a.id)}
              >
                <span className="artifact-index-row-icon" aria-hidden="true">
                  <ArtifactKindIcon kind={a.kind} size={ICON.sm} name={artifactFileName(a)} />
                </span>
                <span className="artifact-index-row-copy">
                  <span className="artifact-index-row-title">{a.title}</span>
                  <span className="artifact-index-row-meta">
                    {artifactShowsKind(a.kind) ? (
                      <span className={`artifact-kind-tag is-${a.kind}`}>
                        {t(`artifact.kind.${a.kind}`, { defaultValue: a.kind })}
                      </span>
                    ) : null}
                    {a.createdAt ? (
                      <span className="artifact-index-row-date tnum">
                        {formatArtifactDate(a.createdAt, i18n.language)}
                      </span>
                    ) : null}
                  </span>
                </span>
              </Button>
            ))
          )}
        </div>
      </div>
    </nav>
  );
}
