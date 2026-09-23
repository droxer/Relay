"use client";
import { useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createSkill,
  deleteSkill,
  importSkill,
  reimportSkill,
  reviseSkill,
  updateSkill,
} from "../api";
import { useSkill, useSkills, SKILLS_QUERY_KEY } from "../hooks/useSkills";
import { useEmployeeAgents } from "../hooks/useEmployeeAgents";
import { useTeams } from "../hooks/useTeams";
import type { CurrentUser, SkillFileInput, SkillsResponse, SkillVisibility } from "../types";
import { ActionAdd, ICON } from "./icons";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "./PageHeader";
import { SearchInput } from "@/components/ui/search-input";
import { RelayEmptyState } from "./RelayEmptyState";
import { compactDate } from "../lib/workspaceFormat";
import { ShareSkillDrawer } from "./ShareSkillDrawer";
import { Drawer } from "@/components/ui/Drawer";
import { useTranslation } from "react-i18next";

type CreateMode = "upload" | "github";
const SOURCE_LABELS: Record<CreateMode, string> = {
  upload: "skills.upload_bundle",
  github: "skills.github",
};
interface SkillDraft {
  name: string; namespace: string;
  visibility: SkillVisibility; files: SkillFileInput[];
  url: string; ref: string; subpath: string;
}
const EMPTY_DRAFT: SkillDraft = {
  name: "", namespace: "",
  visibility: "private", files: [], url: "", ref: "HEAD", subpath: "",
};
function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
async function encodeFiles(list: FileList): Promise<SkillFileInput[]> {
  const files = [...list];
  if (files.length > 300) throw new Error("too-many-files");
  if (files.some((file) => file.size > 1024 * 1024)) throw new Error("file-too-large");
  if (files.reduce((bytes, file) => bytes + file.size, 0) > 4 * 1024 * 1024)
    throw new Error("revision-too-large");
  const paths = files.map((file) => file.webkitRelativePath
    ? file.webkitRelativePath.split("/").slice(1).join("/") : file.name);
  if (!paths.includes("SKILL.md")) throw new Error("skill-md-required");
  return Promise.all(
    files.map(async (file, index) => ({
      // Directory pickers include the selected folder; bundle paths start inside it.
      path: paths[index]!,
      contentBase64: encodeBytes(new Uint8Array(await file.arrayBuffer().catch(() => {
        throw new Error("file-read-failed");
      }))),
    })),
  );
}

export function SkillsPage({ currentUser }: { currentUser: CurrentUser }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const drawerId = useId();
  const skillsQuery = useSkills();
  const { agents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const detailQuery = useSkill(selectedId);
  const [mode, setMode] = useState<CreateMode | null>(null);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadRequest = useRef({ draft: 0, revision: 0 });
  // Publication drafts must not overwrite the selected skill's metadata editor.
  const [draft, setDraft] = useState(EMPTY_DRAFT);
  const patchDraft = (patch: Partial<SkillDraft>) =>
    setDraft((current) => ({ ...current, ...patch }));
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<SkillVisibility>("private");
  const [revisionFiles, setRevisionFiles] = useState<SkillFileInput[]>([]);
  const [revisionNote, setRevisionNote] = useState("");
  const skill = detailQuery.data;
  const errorText = (value: unknown) => {
    const code = value && typeof value === "object" && "code" in value && typeof value.code === "string"
      ? value.code
      : value instanceof Error ? value.message : "unknown";
    return t(`skills.errors.${code}`, { defaultValue: t("skills.errors.unknown") });
  };
  const owned = skill?.ownerEmployeeId === currentUser.employeeId;
  useEffect(() => () => {
    uploadRequest.current.draft++;
    uploadRequest.current.revision++;
  }, []);
  useEffect(() => {
    uploadRequest.current.revision++;
    setRevisionFiles([]);
    setRevisionNote("");
    setError(null);
  }, [selectedId]);
  async function readBundle(list: FileList, target: "draft" | "revision") {
    const request = ++uploadRequest.current[target];
    const setFiles = (files: SkillFileInput[]) => target === "draft"
      ? patchDraft({ files }) : setRevisionFiles(files);
    setFiles([]);
    setError(null);
    try {
      const files = await encodeFiles(list);
      if (request === uploadRequest.current[target]) setFiles(files);
    } catch (error) {
      if (request === uploadRequest.current[target]) setError(errorText(error));
    }
  }
  useEffect(() => {
    if (!selectedId && skillsQuery.data?.skills[0])
      setSelectedId(skillsQuery.data.skills[0].id);
  }, [selectedId, skillsQuery.data]);
  useEffect(() => {
    if (skill) {
      setDisplayName(skill.displayName);
      setDescription(skill.description);
      setVisibility(skill.visibility);
    }
  }, [skill]);
  async function refresh(id?: string) {
    await queryClient.invalidateQueries({ queryKey: [SKILLS_QUERY_KEY] });
    if (id)
      await queryClient.invalidateQueries({ queryKey: [SKILLS_QUERY_KEY, id] });
  }
  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setError(null);
    setMode("upload");
  }
  function resetCreate() {
    uploadRequest.current.draft++;
    setMode(null);
    setDraft(EMPTY_DRAFT);
    setError(null);
  }
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const shared = {
        name: draft.name,
        ...(draft.namespace ? { namespace: draft.namespace } : {}),
        visibility: draft.visibility,
      };
      const created =
        mode === "github"
          ? await importSkill({ ...shared, url: draft.url, ref: draft.ref, subpath: draft.subpath })
          : await createSkill({
              ...shared,
              source: "upload",
              files: draft.files,
            });
      resetCreate();
      setSelectedId(created.id);
      await refresh(created.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  // Save waits for something to save, like every other settings form here
  // (the control panel's organization Save is disabled until its field is
  // dirty). Enabled at rest, it sat on the page as a live cobalt button beside
  // "Share" — a second primary with nothing to do.
  const metadataChanged = Boolean(skill) && (
    displayName !== skill?.displayName
    || description !== skill?.description
    || visibility !== skill?.visibility
  );
  async function saveMetadata() {
    if (!skill) return;
    setBusy(true);
    setError(null);
    try {
      await updateSkill(skill.id, { displayName, description, visibility });
      await refresh(skill.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function addRevision() {
    if (!skill || !revisionFiles.length) return;
    setBusy(true);
    setError(null);
    try {
      await reviseSkill(skill.id, revisionFiles, revisionNote);
      setRevisionFiles([]);
      setRevisionNote("");
      await refresh(skill.id);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!skill || !window.confirm(t("skills.delete_confirm", { name: skill.displayName }))) return;
    setBusy(true);
    try {
      await deleteSkill(skill.id);
      // Remove the cached roster entry before automatic selection can pick it again.
      await queryClient.cancelQueries({ queryKey: [SKILLS_QUERY_KEY], exact: true });
      queryClient.setQueryData<SkillsResponse>([SKILLS_QUERY_KEY], (current) => current
        ? { ...current, skills: current.skills.filter((item) => item.id !== skill.id) }
        : current);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const skills = skillsQuery.data?.skills ?? [];
  const sourceLabelId = `${drawerId}-source`;
  const visibilityLabelId = `${drawerId}-visibility`;
  const editorVisibilityLabelId = `${drawerId}-editor-visibility`;
  /* Matched against everything the row actually prints — the display name and
     the slug beneath it — so a search never hides a row whose visible text
     contains the term. */
  const needle = query.trim().toLowerCase();
  const visibleSkills = needle
    ? skills.filter((item) =>
        `${item.displayName} ${item.slug} ${item.description}`.toLowerCase().includes(needle),
      )
    : skills;

  /* The landing frame is the roster frame every other rail route uses: a
     <PageHeader> over the list inside the rail, not a full-width banner above
     both columns, and the shared zero-data surface instead of a local dashed
     card. The create affordance is the ghost plus the projects, threads and
     agents rails all carry. */
  return (
    <main className="skills-page" id="skills-panel" data-view={skills.length ? "list" : "empty"}>
      <nav className="skills-list" aria-label={t("skills.library_label")}>
        {/* No kicker: the library is a section of personal settings, and the
            section rail one column to the left already names it. The skill
            detail's eyebrow below is record metadata (source · visibility),
            not surface identity, so it stays. */}
        <PageHeader
          title={t("skills.title")}
          count={t("skills.count", { count: skills.length })}
          titleVariant="display"
          layout="stacked"
          actions={
            <Button
              variant="ghost"
              type="button"
              className="page-header-icon-action page-header-icon-action--primary"
              tooltip={t("skills.publish_skill")}
              onClick={openCreate}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
            </Button>
          }
        />

        {/* The shared filter band every list rail carries (inputs.css). The
            library rail shipped without one, so it was the only roster of the
            four that could not be searched — and the only one whose header sat
            straight on its list. */}
        <div className="list-filter-bar">
          <SearchInput
            className="list-filter-search"
            iconSize={ICON.sm}
            label={t("skills.search_label")}
            name="skills-query"
            value={query}
            placeholder={t("skills.search_placeholder")}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        {skillsQuery.isLoading ? (
          <div className="route-loading" role="status" aria-live="polite">
            {t("skills.loading")}
          </div>
        ) : skillsQuery.error ? (
          <RelayEmptyState
            title={t("skills.load_failed")}
            body={errorText(skillsQuery.error)}
            actions={
              <Button type="button" variant="outline" onClick={() => void skillsQuery.refetch()}>
                {t("skills.try_again")}
              </Button>
            }
          />
        ) : !visibleSkills.length ? (
          /* Same split the agent and team rosters make: a library with nothing
             in it offers the create action, a library filtered down to nothing
             does not — the fix there is to change the search, not to publish. */
          <RelayEmptyState
            title={skills.length ? t("skills.empty_filtered_title") : t("skills.empty_title")}
            body={skills.length ? t("skills.empty_filtered_body") : t("skills.empty_body")}
            actions={
              skills.length ? undefined : (
                <Button type="button" variant="outline" onClick={openCreate}>
                  {t("skills.publish_first")}
                </Button>
              )
            }
          />
        ) : (
          /* The library rail is the same object as the thread, agent, and team
             rails — a selectable roster beside a detail pane — so it wears
             their row grammar: a .rail-row carrying the selection, the inset
             on the inner button (that button is the focus target), and one
             meta line under the name. */
          <ul className="skills-roster-list" data-density="compact">
            {visibleSkills.map((item) => (
              <li
                key={item.id}
                className="skills-roster-row rail-row"
                data-selected={selectedId === item.id ? "true" : "false"}
              >
                <Button
                  variant="ghost"
                  type="button"
                  className="skills-roster-row-select"
                  aria-current={selectedId === item.id ? "page" : undefined}
                  onClick={() => setSelectedId(item.id)}
                >
                  <span className="skills-roster-row-name">{item.displayName}</span>
                  <span className="skills-roster-row-meta">
                    <span className="skills-roster-row-slug">{item.slug}</span>
                    <span className="skills-roster-row-facts">
                      {t(`skills.visibility.${item.visibility}`)} · {t("skills.granted_count", { count: item.grantedAgentCount ?? 0 })}
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </nav>
      <section className="skill-detail">
        {detailQuery.isLoading ? (
          <p className="route-loading" role="status">{t("skills.loading_detail")}</p>
        ) : detailQuery.error ? (
          <p className="route-loading" role="alert">{errorText(detailQuery.error)}</p>
        ) : skill ? (
          <>
            {/* One header vocabulary for the whole route: the record variant a
                detail pane under a roster takes, demoted to h2 so the rail's
                title stays the page's only h1. */}
            <PageHeader
              kicker={`${t(`skills.source.${skill.source}`)} · ${t(`skills.visibility.${skill.visibility}`)}`}
              title={skill.displayName}
              /* The slug rides beside the name rather than under it: a third
                 line made this the one header in the surface that could not
                 sit on the shared header step (section-rail.css). */
              count={<span className="skill-code">{skill.slug}</span>}
              titleVariant="record"
              titleAs="h2"
              layout="stacked"
              actions={
                <Button type="button" onClick={() => setSharing(true)}>
                  {t("skills.share")}
                </Button>
              }
            />
            <div className="skill-detail-body">
            <p className="skill-description">{skill.description}</p>
            <dl className="skill-stats">
              <div>
                <dt>{t("skills.current_revision")}</dt>
                <dd>v{skill.revisions[0]?.revision ?? 1}</dd>
              </div>
              <div>
                <dt>{t("skills.files")}</dt>
                <dd>{skill.files.length}</dd>
              </div>
              <div>
                <dt>{t("skills.granted")}</dt>
                <dd>{skill.grantedAgentIds.length}</dd>
              </div>
            </dl>
            <section>
              <h3>{t("skills.bundle")}</h3>
              <ul className="skill-file-list">
                {skill.files.map((file) => (
                  <li key={file.path}>
                    <code>{file.path}</code>
                    <span>{t("skills.bytes", { count: file.bytes, value: file.bytes.toLocaleString(i18n.language) })}</span>
                  </li>
                ))}
              </ul>
            </section>
            <section>
              <h3>{t("skills.revision_history")}</h3>
              <ol className="skill-revisions">
                {skill.revisions.map((revision) => (
                  <li key={revision.id}>
                    <strong>v{revision.revision}</strong>
                    <span>{revision.note || t("skills.published_bundle")}</span>
                    {/* The shared instant format ("Sep 23, 01:30 AM"), not a raw
                        numeric date: every other timestamp in the app reads
                        this way, and a bundle can take several revisions a day. */}
                    <time className="tnum" dateTime={revision.createdAt}>
                      {compactDate(revision.createdAt, i18n.language)}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
            {owned ? (
              <section className="skill-owner-tools">
                <h3>{t("skills.manage")}</h3>
                <Field label={t("skills.display_name")} required hint={t("skills.display_name_hint")}>
                  <Input
                    required
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </Field>
                <Field label={t("skills.description")} required hint={t("skills.description_hint")}>
                  <Textarea
                    required
                    rows={2}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </Field>
                <Field
                  className="skill-visibility-field"
                  label={t("skills.visibility_label")}
                  labelId={editorVisibilityLabelId}
                  wrapper="div"
                  hint={t(`skills.visibility_hints.${visibility}`)}
                >
                  <div
                    className="skill-segment"
                    role="group"
                    aria-labelledby={editorVisibilityLabelId}
                  >
                    {(["private", "org"] as const).map((option) => (
                      <button
                        key={option}
                        type="button"
                        className={visibility === option ? "active" : ""}
                        aria-pressed={visibility === option}
                        onClick={() => setVisibility(option)}
                      >
                        {t(`skills.visibility.${option}`)}
                      </button>
                    ))}
                  </div>
                </Field>
                {skill.source === "git" ? null : (
                  <>
                    <Field
                      label={t("skills.new_bundle")}
                      optional={t("skills.optional")}
                      hint={
                        revisionFiles.length
                          ? t("skills.files_ready", { count: revisionFiles.length })
                          : t("skills.select_directory")
                      }
                    >
                      <input
                        key={skill.id}
                        type="file"
                        disabled={busy}
                        className="skill-file-input"
                        data-filled={revisionFiles.length ? "true" : undefined}
                        multiple
                        {...({ webkitdirectory: "" } as object)}
                        onChange={(e) =>
                          e.target.files &&
                          void readBundle(e.target.files, "revision")
                        }
                      />
                    </Field>
                    <Field
                      label={t("skills.revision_note")}
                      optional={t("skills.optional")}
                      hint={t("skills.revision_note_hint")}
                    >
                      <Input
                        value={revisionNote}
                        onChange={(e) => setRevisionNote(e.target.value)}
                      />
                    </Field>
                  </>
                )}
                {/* Fields above, actions in one row below — the shape every
                    other form in the app has. These used to be four stretched
                    full-width buttons interleaved with the fields, so a
                    920px-wide primary bar sat between two inputs. */}
                <footer className="skill-owner-actions">
                  <Button
                    variant="destructive"
                    className="skill-owner-actions-leading"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    {t("skills.delete_skill")}
                  </Button>
                  {skill.source === "git" ? (
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={async () => {
                        setBusy(true);
                        try {
                          await reimportSkill(skill.id);
                          await refresh(skill.id);
                        } finally {
                          setBusy(false);
                        }
                      }}
                    >
                      {t("skills.reimport")}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      disabled={busy || !revisionFiles.length}
                      onClick={() => void addRevision()}
                    >
                      {t("skills.publish_revision")}
                    </Button>
                  )}
                  <Button
                    disabled={busy || !metadataChanged || !displayName.trim() || !description.trim()}
                    onClick={() => void saveMetadata()}
                  >
                    {t("skills.save_details")}
                  </Button>
                </footer>
              </section>
            ) : null}
            </div>
          </>
        ) : null}
      </section>
      {mode ? (
        <Drawer
          open
          onClose={() => { if (!busy) resetCreate(); }}
          kicker={t("skills.eyebrow")}
          title={t("skills.publish_title")}
          subtitle={t("skills.publish_subtitle")}
          width="form"
          closeLabel={t("skills.close")}
          bodyClassName="skill-drawer"
        >
            <Field
              label={t("skills.source_label")}
              labelId={sourceLabelId}
              wrapper="div"
              hint={t(`skills.source_hints.${mode}`)}
            >
              <div className="skill-tabs" role="group" aria-labelledby={sourceLabelId}>
                {(["upload", "github"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={mode === option ? "active" : ""}
                    aria-pressed={mode === option}
                    disabled={busy}
                    onClick={() => {
                      if (mode === option) return;
                      uploadRequest.current.draft++;
                      patchDraft({ files: [] });
                      setError(null);
                      setMode(option);
                    }}
                  >
                    {t(SOURCE_LABELS[option])}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t("skills.skill_name")} required hint={t("skills.skill_name_hint")}>
              <Input
                data-modal-initial-focus
                required
                autoComplete="off"
                spellCheck={false}
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
                placeholder="release-notes"
              />
            </Field>
            <Field
              label={t("skills.namespace")}
              optional={t("skills.optional")}
              hint={t("skills.namespace_hint")}
            >
              <Input
                autoComplete="off"
                spellCheck={false}
                value={draft.namespace}
                onChange={(e) => patchDraft({ namespace: e.target.value })}
                placeholder="acme"
              />
            </Field>
            {mode === "upload" ? (
              <Field
                label={t("skills.bundle_directory")}
                required
                hint={
                  draft.files.length
                    ? t("skills.files_ready", { count: draft.files.length })
                    : t("skills.select_directory")
                }
              >
                <input
                  type="file"
                  disabled={busy}
                  className="skill-file-input"
                  data-filled={draft.files.length ? "true" : undefined}
                  required
                  multiple
                  {...({ webkitdirectory: "" } as object)}
                  onChange={(e) =>
                    e.target.files &&
                    void readBundle(e.target.files, "draft")
                  }
                />
              </Field>
            ) : (
              <>
                <Field label={t("skills.repository_url")} required>
                  <Input
                    required
                    autoComplete="off"
                    spellCheck={false}
                    value={draft.url}
                    onChange={(e) => patchDraft({ url: e.target.value })}
                    placeholder="https://github.com/org/repo"
                  />
                </Field>
                <div className="skill-field-row">
                  <Field label={t("skills.git_ref")} optional={t("skills.optional")}>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.ref}
                      onChange={(e) => patchDraft({ ref: e.target.value })}
                    />
                  </Field>
                  <Field label={t("skills.subpath")} optional={t("skills.optional")}>
                    <Input
                      autoComplete="off"
                      spellCheck={false}
                      value={draft.subpath}
                      onChange={(e) => patchDraft({ subpath: e.target.value })}
                      placeholder="skills/my-skill"
                    />
                  </Field>
                </div>
              </>
            )}
            <Field
              label={t("skills.visibility_label")}
              labelId={visibilityLabelId}
              wrapper="div"
              hint={t(`skills.visibility_hints.${draft.visibility}`)}
            >
              <div className="skill-segment" role="group" aria-labelledby={visibilityLabelId}>
                {(["private", "org"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={draft.visibility === option ? "active" : ""}
                    aria-pressed={draft.visibility === option}
                    onClick={() => patchDraft({ visibility: option })}
                  >
                    {t(`skills.visibility.${option}`)}
                  </button>
                ))}
              </div>
            </Field>
            {error ? (
              <p role="alert" className="skill-error">
                {error}
              </p>
            ) : null}
            <footer>
              <Button variant="outline" disabled={busy} onClick={resetCreate}>
                {t("skills.cancel")}
              </Button>
              <Button
                disabled={
                  busy ||
                  !draft.name.trim() ||
                  (mode === "upload" && !draft.files.length) ||
                  (mode === "github" && !draft.url)
                }
                onClick={() => void publish()}
              >
                {busy ? t("skills.publishing") : t("skills.publish")}
              </Button>
            </footer>
        </Drawer>
      ) : null}
      {sharing && skill ? (
        <ShareSkillDrawer
          skill={skill}
          agents={agents}
          teams={teams}
          employeeId={currentUser.employeeId}
          onClose={() => setSharing(false)}
        />
      ) : null}
    </main>
  );
}
