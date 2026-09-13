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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
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
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!skill || !window.confirm(`Delete ${skill.displayName}?`)) return;
    setBusy(true);
    try {
      await deleteSkill(skill.id);
      setSelectedId(null);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="skills-page" id="skills-panel">
      <header className="skills-header">
        <div>
          <p className="skill-eyebrow">Managed capabilities</p>
          <h1>Skills</h1>
          <p>
            Publish once, then grant a versioned bundle to your Claude, Codex,
            Pi, or Kimi agents.
          </p>
        </div>
        <Button onClick={() => setMode("author")}>Publish skill</Button>
      </header>
      {skillsQuery.isLoading ? (
        <section className="route-loading" role="status">
          Loading skills…
        </section>
      ) : skillsQuery.error ? (
        <section className="route-loading" role="alert">
          <p>{String(skillsQuery.error)}</p>
          <Button onClick={() => void skillsQuery.refetch()}>Try again</Button>
        </section>
      ) : !skillsQuery.data?.skills.length ? (
        <section className="skills-empty">
          <h2>Your skills library is empty</h2>
          <p>
            Author a skill, upload a directory bundle, or import one from
            GitHub.
          </p>
          <Button onClick={() => setMode("author")}>
            Publish your first skill
          </Button>
        </section>
      ) : (
        <div className="skills-layout">
          <nav className="skills-list" aria-label="Skills library">
            {skillsQuery.data.skills.map((item) => (
              <button
                key={item.id}
                className={selectedId === item.id ? "active" : ""}
                onClick={() => setSelectedId(item.id)}
              >
                <strong>{item.displayName}</strong>
                <span>{item.slug}</span>
                <small>
                  {item.visibility} · {item.grantedAgentCount ?? 0} granted
                </small>
              </button>
            ))}
          </nav>
          <section className="skill-detail">
            {detailQuery.isLoading ? (
              <p role="status">Loading skill…</p>
            ) : detailQuery.error ? (
              <p role="alert">{String(detailQuery.error)}</p>
            ) : skill ? (
              <>
                <header>
                  <div>
                    <p className="skill-eyebrow">
                      {skill.source} · {skill.visibility}
                    </p>
                    <h2>{skill.displayName}</h2>
                    <p className="skill-code">{skill.slug}</p>
                  </div>
                  <Button onClick={() => setSharing(true)}>Share</Button>
                </header>
                <p>{skill.description}</p>
                <dl className="skill-stats">
                  <div>
                    <dt>Current revision</dt>
                    <dd>v{skill.revisions[0]?.revision ?? 1}</dd>
                  </div>
                  <div>
                    <dt>Files</dt>
                    <dd>{skill.files.length}</dd>
                  </div>
                  <div>
                    <dt>Granted</dt>
                    <dd>{skill.grantedAgentIds.length}</dd>
                  </div>
                </dl>
                <section>
                  <h3>Bundle</h3>
                  <ul className="skill-file-list">
                    {skill.files.map((file) => (
                      <li key={file.path}>
                        <code>{file.path}</code>
                        <span>{file.bytes.toLocaleString()} bytes</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section>
                  <h3>Revision history</h3>
                  <ol className="skill-revisions">
                    {skill.revisions.map((revision) => (
                      <li key={revision.id}>
                        <strong>v{revision.revision}</strong>
                        <span>{revision.note || "Published bundle"}</span>
                        <time>
                          {new Date(revision.createdAt).toLocaleDateString()}
                        </time>
                      </li>
                    ))}
                  </ol>
                </section>
                {owned ? (
                  <section className="skill-owner-tools">
                    <h3>Manage</h3>
                    <label>
                      Display name
                      <Input
                        value={displayName}
                        onChange={(e) => setDisplayName(e.target.value)}
                      />
                    </label>
                    <label>
                      Description
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
                        Private
                      </button>
                      <button
                        className={visibility === "org" ? "active" : ""}
                        onClick={() => setVisibility("org")}
                      >
                        Organization
                      </button>
                    </div>
                    <Button disabled={busy} onClick={() => void saveMetadata()}>
                      Save details
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
                        Re-import from GitHub
                      </Button>
                    ) : (
                      <>
                        <label>
                          New bundle
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
                          Revision note
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
                          Publish revision
                        </Button>
                      </>
                    )}
                    <Button
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      Delete skill
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
          title="Publish a skill"
          closeLabel="Close"
          bodyClassName="skill-drawer"
        >
            <div className="skill-tabs">
              <button
                className={mode === "author" ? "active" : ""}
                onClick={() => setMode("author")}
              >
                Author
              </button>
              <button
                className={mode === "upload" ? "active" : ""}
                onClick={() => setMode("upload")}
              >
                Upload bundle
              </button>
              <button
                className={mode === "github" ? "active" : ""}
                onClick={() => setMode("github")}
              >
                GitHub
              </button>
            </div>
            <label>
              Skill name
              <Input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="release-notes"
              />
            </label>
            <label>
              Namespace
              <Input
                value={namespace}
                onChange={(e) => setNamespace(e.target.value)}
                placeholder="optional"
              />
            </label>
            <label>
              Description
              <Textarea
                required
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            {mode === "author" ? (
              <label>
                Instructions
                <Textarea
                  rows={10}
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder="Explain when and how the agent should use this skill."
                />
              </label>
            ) : mode === "upload" ? (
              <label>
                Bundle directory
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
                    ? `${files.length} files ready`
                    : "Select a directory containing SKILL.md"}
                </small>
              </label>
            ) : (
              <>
                <label>
                  Repository URL
                  <Input
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    placeholder="https://github.com/org/repo"
                  />
                </label>
                <label>
                  Git ref
                  <Input value={ref} onChange={(e) => setRef(e.target.value)} />
                </label>
                <label>
                  Subpath
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
                Private
              </button>
              <button
                className={visibility === "org" ? "active" : ""}
                onClick={() => setVisibility("org")}
              >
                Organization
              </button>
            </div>
            {error ? (
              <p role="alert" className="skill-error">
                {error}
              </p>
            ) : null}
            <footer>
              <Button variant="outline" onClick={resetCreate}>
                Cancel
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
                {busy ? "Publishing…" : "Publish"}
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
