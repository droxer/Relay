"use client";
import { useEffect, useState } from "react";
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
import type { CurrentUser, SkillFileInput, SkillVisibility } from "../types";
import { ActionAdd, ICON } from "./icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "./PageHeader";
import { RelayEmptyState } from "./RelayEmptyState";
import { ShareSkillDrawer } from "./ShareSkillDrawer";
import { Drawer } from "@/components/ui/Drawer";
import { useTranslation } from "react-i18next";

type CreateMode = "author" | "upload" | "github";
interface SkillDraft {
  name: string; namespace: string; displayName: string; description: string;
  visibility: SkillVisibility; instructions: string; files: SkillFileInput[];
  url: string; ref: string; subpath: string;
}
const EMPTY_DRAFT: SkillDraft = {
  name: "", namespace: "", displayName: "", description: "",
  visibility: "private", instructions: "", files: [], url: "", ref: "HEAD", subpath: "",
};
function encodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}
function encodeText(value: string) {
  return encodeBytes(new TextEncoder().encode(value));
}
async function encodeFiles(list: FileList): Promise<SkillFileInput[]> {
  return Promise.all(
    [...list].map(async (file) => ({
      path: (file.webkitRelativePath || file.name).replace(/^\.\//, ""),
      contentBase64: encodeBytes(new Uint8Array(await file.arrayBuffer())),
    })),
  );
}

export function SkillsPage({ currentUser }: { currentUser: CurrentUser }) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const skillsQuery = useSkills();
  const { agents } = useEmployeeAgents(currentUser.employeeId);
  const { teams } = useTeams(currentUser.employeeId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const detailQuery = useSkill(selectedId);
  const [mode, setMode] = useState<CreateMode | null>(null);
  const [sharing, setSharing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* The publish drawer and the detail editor both edit a display name, a
     description, and a visibility. They used to share one set of fields, so
     selecting a skill pre-filled the publish form with that skill's metadata
     and typing in the drawer rewrote the pending edits underneath it. */
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
    setMode("author");
  }
  function resetCreate() {
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
        ...(draft.displayName ? { displayName: draft.displayName } : {}),
        ...(draft.description ? { description: draft.description } : {}),
        visibility: draft.visibility,
      };
      const created =
        mode === "github"
          ? await importSkill({ ...shared, url: draft.url, ref: draft.ref, subpath: draft.subpath })
          : await createSkill({
              ...shared,
              source: mode === "upload" ? "upload" : "authored",
              files:
                mode === "author"
                  ? [
                      {
                        path: "SKILL.md",
                        contentBase64: encodeText(
                          `---\nname: ${JSON.stringify(draft.name)}\ndescription: ${JSON.stringify(draft.description)}\n---\n\n${draft.instructions}\n`,
                        ),
                      },
                    ]
                  : draft.files,
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
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  const skills = skillsQuery.data?.skills ?? [];

  /* The landing frame is the roster frame every other rail route uses: a
     <PageHeader> over the list inside the rail, not a full-width banner above
     both columns, and the shared zero-data surface instead of a local dashed
     card. The create affordance is the ghost plus the projects, threads and
     agents rails all carry. */
  return (
    <main className="skills-page" id="skills-panel" data-view={skills.length ? "list" : "empty"}>
      <nav className="skills-list" aria-label={t("skills.library_label")}>
        <PageHeader
          kicker={t("skills.eyebrow")}
          title={t("skills.title")}
          count={t("skills.count", { count: skills.length })}
          titleVariant="display"
          layout="stacked"
          actions={
            <Button
              variant="ghost"
              type="button"
              className="page-header-icon-action"
              tooltip={t("skills.publish_skill")}
              onClick={openCreate}
            >
              <ActionAdd size={ICON.md} aria-hidden="true" />
            </Button>
          }
        />
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
        ) : !skills.length ? (
          <RelayEmptyState
            title={t("skills.empty_title")}
            body={t("skills.empty_body")}
            actions={
              <Button type="button" variant="outline" onClick={openCreate}>
                {t("skills.publish_first")}
              </Button>
            }
          />
        ) : (
          /* The library rail is the same object as the thread, agent, and team
             rails — a selectable roster beside a detail pane — so it wears
             their row grammar: a .rail-row carrying the selection, the inset
             on the inner button (that button is the focus target), and one
             meta line under the name. */
          <ul className="skills-roster-list" data-density="compact">
            {skills.map((item) => (
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
              subtitle={<span className="skill-code">{skill.slug}</span>}
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
                    <time>
                      {new Date(revision.createdAt).toLocaleDateString(i18n.language)}
                    </time>
                  </li>
                ))}
              </ol>
            </section>
            {owned ? (
              <section className="skill-owner-tools">
                <h3>{t("skills.manage")}</h3>
                <label>
                  {t("skills.display_name")}
                  <Input
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                  />
                </label>
                <label>
                  {t("skills.description")}
                  <Textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                  />
                </label>
                <div className="skill-segment">
                  <button
                    className={visibility === "private" ? "active" : ""}
                    onClick={() => setVisibility("private")}
                  >
                    {t("skills.visibility.private")}
                  </button>
                  <button
                    className={visibility === "org" ? "active" : ""}
                    onClick={() => setVisibility("org")}
                  >
                    {t("skills.visibility.org")}
                  </button>
                </div>
                {skill.source === "git" ? null : (
                  <>
                    <label>
                      {t("skills.new_bundle")}
                      <input
                        type="file"
                        multiple
                        {...({ webkitdirectory: "" } as object)}
                        onChange={(e) =>
                          e.target.files &&
                          void encodeFiles(e.target.files).then(
                            setRevisionFiles,
                          )
                        }
                      />
                    </label>
                    <label>
                      {t("skills.revision_note")}
                      <Input
                        value={revisionNote}
                        onChange={(e) => setRevisionNote(e.target.value)}
                      />
                    </label>
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
                  <Button disabled={busy} onClick={() => void saveMetadata()}>
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
          onClose={resetCreate}
          title={t("skills.publish_title")}
          closeLabel={t("skills.close")}
          bodyClassName="skill-drawer"
        >
            <div className="skill-tabs">
              <button
                className={mode === "author" ? "active" : ""}
                onClick={() => setMode("author")}
              >
                {t("skills.author")}
              </button>
              <button
                className={mode === "upload" ? "active" : ""}
                onClick={() => setMode("upload")}
              >
                {t("skills.upload_bundle")}
              </button>
              <button
                className={mode === "github" ? "active" : ""}
                onClick={() => setMode("github")}
              >
                {t("skills.github")}
              </button>
            </div>
            <label>
              {t("skills.skill_name")}
              <Input
                required
                value={draft.name}
                onChange={(e) => patchDraft({ name: e.target.value })}
                placeholder="release-notes"
              />
            </label>
            <label>
              {t("skills.namespace")}
              <Input
                value={draft.namespace}
                onChange={(e) => patchDraft({ namespace: e.target.value })}
                placeholder={t("skills.optional")}
              />
            </label>
            <label>
              {t("skills.description")}
              <Textarea
                required
                value={draft.description}
                onChange={(e) => patchDraft({ description: e.target.value })}
              />
            </label>
            {mode === "author" ? (
              <label>
                {t("skills.instructions")}
                <Textarea
                  rows={10}
                  value={draft.instructions}
                  onChange={(e) => patchDraft({ instructions: e.target.value })}
                  placeholder={t("skills.instructions_placeholder")}
                />
              </label>
            ) : mode === "upload" ? (
              <label>
                {t("skills.bundle_directory")}
                <input
                  type="file"
                  multiple
                  {...({ webkitdirectory: "" } as object)}
                  onChange={(e) =>
                    e.target.files &&
                    void encodeFiles(e.target.files).then((files) => patchDraft({ files }))
                  }
                />
                <small>
                  {draft.files.length
                    ? t("skills.files_ready", { count: draft.files.length })
                    : t("skills.select_directory")}
                </small>
              </label>
            ) : (
              <>
                <label>
                  {t("skills.repository_url")}
                  <Input
                    value={draft.url}
                    onChange={(e) => patchDraft({ url: e.target.value })}
                    placeholder="https://github.com/org/repo"
                  />
                </label>
                <label>
                  {t("skills.git_ref")}
                  <Input value={draft.ref} onChange={(e) => patchDraft({ ref: e.target.value })} />
                </label>
                <label>
                  {t("skills.subpath")}
                  <Input
                    value={draft.subpath}
                    onChange={(e) => patchDraft({ subpath: e.target.value })}
                    placeholder="skills/my-skill"
                  />
                </label>
              </>
            )}
            <div className="skill-segment">
              <button
                className={draft.visibility === "private" ? "active" : ""}
                onClick={() => patchDraft({ visibility: "private" })}
              >
                {t("skills.visibility.private")}
              </button>
              <button
                className={draft.visibility === "org" ? "active" : ""}
                onClick={() => patchDraft({ visibility: "org" })}
              >
                {t("skills.visibility.org")}
              </button>
            </div>
            {error ? (
              <p role="alert" className="skill-error">
                {error}
              </p>
            ) : null}
            <footer>
              <Button variant="outline" onClick={resetCreate}>
                {t("skills.cancel")}
              </Button>
              <Button
                disabled={
                  busy ||
                  !draft.name ||
                  !draft.description ||
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
          onClose={() => setSharing(false)}
        />
      ) : null}
    </main>
  );
}
