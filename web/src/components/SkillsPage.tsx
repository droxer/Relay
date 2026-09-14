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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ShareSkillDrawer } from "./ShareSkillDrawer";
import { Drawer } from "@/components/ui/Drawer";
import { useTranslation } from "react-i18next";

type CreateMode = "author" | "upload" | "github";
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
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [namespace, setNamespace] = useState("");
  const [visibility, setVisibility] = useState<SkillVisibility>("private");
  const [instructions, setInstructions] = useState("");
  const [files, setFiles] = useState<SkillFileInput[]>([]);
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("HEAD");
  const [subpath, setSubpath] = useState("");
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
  function resetCreate() {
    setMode(null);
    setName("");
    setDisplayName("");
    setDescription("");
    setNamespace("");
    setInstructions("");
    setFiles([]);
    setError(null);
  }
  async function publish() {
    setBusy(true);
    setError(null);
    try {
      const created =
        mode === "github"
          ? await importSkill({
              name,
              ...(namespace ? { namespace } : {}),
              ...(displayName ? { displayName } : {}),
              ...(description ? { description } : {}),
              visibility,
              url,
              ref,
              subpath,
            })
          : await createSkill({
              name,
              ...(namespace ? { namespace } : {}),
              ...(displayName ? { displayName } : {}),
              ...(description ? { description } : {}),
              visibility,
              source: mode === "upload" ? "upload" : "authored",
              files:
                mode === "author"
                  ? [
                      {
                        path: "SKILL.md",
                        contentBase64: encodeText(
                          `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${instructions}\n`,
                        ),
                      },
                    ]
                  : files,
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

  return (
    <main className="skills-page" id="skills-panel">
      <header className="skills-header">
        <div>
          <p className="skill-eyebrow">{t("skills.eyebrow")}</p>
          <h1>{t("skills.title")}</h1>
          <p>{t("skills.subtitle")}</p>
        </div>
        <Button onClick={() => setMode("author")}>{t("skills.publish_skill")}</Button>
      </header>
      {skillsQuery.isLoading ? (
        <section className="route-loading" role="status">
          {t("skills.loading")}
        </section>
      ) : skillsQuery.error ? (
        <section className="route-loading" role="alert">
          <p>{errorText(skillsQuery.error)}</p>
          <Button onClick={() => void skillsQuery.refetch()}>{t("skills.try_again")}</Button>
        </section>
      ) : !skillsQuery.data?.skills.length ? (
        <section className="skills-empty">
          <h2>{t("skills.empty_title")}</h2>
          <p>{t("skills.empty_body")}</p>
          <Button onClick={() => setMode("author")}>
            {t("skills.publish_first")}
          </Button>
        </section>
      ) : (
        <div className="skills-layout">
          <nav className="skills-list" aria-label={t("skills.library_label")}>
            {skillsQuery.data.skills.map((item) => (
              <button
                key={item.id}
                className={selectedId === item.id ? "active" : ""}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.displayName}</strong>
                <span>{item.slug}</span>
                <small>
                  {t(`skills.visibility.${item.visibility}`)} · {t("skills.granted_count", { count: item.grantedAgentCount ?? 0 })}
                </small>
              </button>
            ))}
          </nav>
          <section className="skill-detail">
            {detailQuery.isLoading ? (
              <p role="status">{t("skills.loading_detail")}</p>
            ) : detailQuery.error ? (
              <p role="alert">{errorText(detailQuery.error)}</p>
            ) : skill ? (
              <>
                <header>
                  <div>
                    <p className="skill-eyebrow">
                      {t(`skills.source.${skill.source}`)} · {t(`skills.visibility.${skill.visibility}`)}
                    </p>
                    <h2>{skill.displayName}</h2>
                    <p className="skill-code">{skill.slug}</p>
                  </div>
                  <Button onClick={() => setSharing(true)}>{t("skills.share")}</Button>
                </header>
                <p>{skill.description}</p>
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
                        <span>{t("skills.bytes", { count: file.bytes.toLocaleString(i18n.language) })}</span>
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
                    <Button disabled={busy} onClick={() => void saveMetadata()}>
                      {t("skills.save_details")}
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
                        <Button
                          variant="outline"
                          disabled={busy || !revisionFiles.length}
                          onClick={() => void addRevision()}
                        >
                          {t("skills.publish_revision")}
                        </Button>
                      </>
                    )}
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      {t("skills.delete_skill")}
                    </Button>
                  </section>
                ) : null}
              </>
            ) : null}
          </section>
        </div>
      )}
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
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="release-notes"
              />
            </label>
            <label>
              {t("skills.namespace")}
              <Input
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder={t("skills.optional")}
              />
            </label>
            <label>
              {t("skills.description")}
              <Textarea
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {mode === "author" ? (
              <label>
                {t("skills.instructions")}
                <Textarea
                  rows={10}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
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
                    void encodeFiles(e.target.files).then(setFiles)
                  }
                />
                <small>
                  {files.length
                    ? t("skills.files_ready", { count: files.length })
                    : t("skills.select_directory")}
                </small>
              </label>
            ) : (
              <>
                <label>
                  {t("skills.repository_url")}
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/org/repo"
                  />
                </label>
                <label>
                  {t("skills.git_ref")}
                  <Input value={ref} onChange={(e) => setRef(e.target.value)} />
                </label>
                <label>
                  {t("skills.subpath")}
                  <Input
                    value={subpath}
                    onChange={(e) => setSubpath(e.target.value)}
                    placeholder="skills/my-skill"
                  />
                </label>
              </>
            )}
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
                  !name ||
                  !description ||
                  (mode === "upload" && !files.length) ||
                  (mode === "github" && !url)
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
