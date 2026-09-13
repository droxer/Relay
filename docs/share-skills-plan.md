# Share Skills Implementation Plan

> **Implementation correction (2026-09-14):** Codex supports skills. All
> instructions below to remove Codex inventory or claim it has no skills are
> superseded. Preserve existing Codex inventory; verify its isolated delivery
> mechanism before implementing grants. See [implementation progress and
> corrections](share-skills-progress.md) for the current task state and other
> reviewed corrections. Task 1 fixes Kimi paths only.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user publish a skill once and dispatch it to the specific agents they choose, with the granted skills delivered to those agents at run time.

**Architecture:** An org-level catalog (`skill_store`) holds multi-file skill bundles as immutable revisions. Grants live on the existing `skillPolicy` field of the agent record. At dispatch the backend resolves an agent's grants into a digest-only manifest carried on the run command; the daemon fetches missing blobs into a content-addressed cache and hands the granted set to the CLI — by flag for Pi and Kimi, by a per-agent config directory for Claude. Codex has no skills concept and grants to it are refused.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy / Alembic (backend), TypeScript + `node --test` (relay-core, relay-daemon), Next.js + React (web).

**Spec:** `docs/share-skills-design.md` — read it before starting. Every task below argues from it.

## Global Constraints

- **The backend never executes agents.** Delivery happens only via daemon commands. Do not add an execution path to the backend.
- **Event log is authoritative.** All store mutations go through `append_event`-style replay; never mutate snapshot fields directly outside the store's replay.
- **Immutability.** Mutations return new objects (spread/merge), never in-place edits.
- **Agent identity is registry-driven.** `AGENT_REGISTRY` in `packages/relay-core/src/agents.ts` is the single source of truth. Dispatch on `skillDelivery.kind`, never on an `AgentName` literal switch.
- **Never print raw JSONL**; rendering stays block-based.
- Publish caps, exact values: **300 files**, **1 MB per file**, **4 MB per revision**.
- Git import: **HTTPS only**, host must be in `org_settings.skillImportAllowedHosts` (default `["github.com"]`), **30 s** timeout, symlinks / absolute paths / `..` rejected, private and link-local IPs rejected after DNS resolution.
- A run **never quietly differs from what was granted**: any skipped skill is named in a thread notice.
- Node ≥ 22.19; Python ≥ 3.12 with `uv`.

**Commands you will need:**
- Python tests: `make backend-test` (single file: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_store.py -v`)
- TypeScript: `make build-packages` then `node --test dist/packages/relay-core/tests/<file>.test.js`
- All tests: `npm test`
- Migrations: `make backend-migrate`

## File Structure

**Created**
| File | Responsibility |
|---|---|
| `backend/relay/persistence/skill_store.py` | Catalog: skills, immutable revisions, files, slug allocation |
| `backend/relay/services/skill_grants.py` | The one seam that reads/writes `skillPolicy` grants |
| `backend/relay/services/skill_bundle.py` | Resolves an agent's grants into a dispatch manifest |
| `backend/relay/services/skill_import.py` | Fenced git import |
| `backend/relay/api/skill_routes.py` | `/api/v1/skills` HTTP surface |
| `backend/migrations/versions/20260914_0070_add_skill_catalog.py` | Tables |
| `packages/relay-daemon/src/agent-skills.ts` | Blob cache, content store, per-kind delivery |
| `web/src/components/SkillsPage.tsx` | Skills library rail + detail |
| `web/src/components/ShareSkillDrawer.tsx` | Agent/team picker → grants |

**Modified**
| File | Change |
|---|---|
| `packages/relay-daemon/src/agent-inventory.ts:39-44` | Fix Kimi dir; drop Codex skills dir |
| `packages/relay-daemon/src/index.ts:1216`, `box.ts:258` | Same Kimi path fix |
| `packages/relay-core/src/agents.ts` | Add `skillDelivery` to `AgentDefinition` |
| `packages/relay-core/src/state.ts` | Add `skill_paths?: string[]` to `AgentState` |
| `packages/relay-core/src/commands.ts` | Emit skill flags for Pi/Kimi |
| `packages/relay-core/src/daemon-node-protocol.ts` | `DaemonRunSkillBundle`, `agent-skills` capability |
| `backend/relay/api/agent_routes.py:384` | Merge catalog grants into `_agent_skills` |
| `backend/relay/api/deps.py`, `backend/relay/app.py` | Wire `skill_store` |
| `backend/relay/api/daemon_node_routes.py` | Blob endpoint |
| `web/src/App.tsx`, `web/src/components/SideNav.tsx` | `skills` route |
| `web/src/components/AgentProfilePanel.tsx:307` | Granted vs installed grouping |

## Phases

Each phase ends with something that works on its own and can be merged.

- **Phase 0** (Task 1) — prerequisite bug fixes. Valuable alone.
- **Phase 1** (Tasks 2-4) — the catalog. Publish and browse skills; nothing is delivered yet.
- **Phase 2** (Tasks 5-6) — grants. Dispatch a skill to agents; still not delivered.
- **Phase 3** (Tasks 7-10) — delivery. The feature becomes real.
- **Phase 4** (Tasks 11-12) — web surfaces.

---

### Task 1: Fix the stale agent skill directories

`~/.kimi` carries a `.migrated-to-kimi-code` marker — it is the dead legacy directory, so the Kimi sweep has always reported zero skills. Codex has no skills concept at all (`codex --help` shows `plugin`/`mcp`/`review`, no skills), so scanning `.codex/skills` implies a capability that does not exist.

**Files:**
- Modify: `packages/relay-daemon/src/agent-inventory.ts:39-44`
- Modify: `packages/relay-daemon/src/index.ts:1216`
- Modify: `packages/relay-daemon/src/box.ts:258`
- Test: `packages/relay-daemon/tests/daemon.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AGENT_INVENTORY_SOURCES` with `kimi.skillsDir === ".kimi-code/skills"` and no `codex.skillsDir`.

- [ ] **Step 1: Write the failing test**

In `packages/relay-daemon/tests/daemon.test.ts`:

```ts
import { AGENT_INVENTORY_SOURCES } from "../src/agent-inventory.js";

describe("agent inventory sources", () => {
  it("scans Kimi's live config directory, not the migrated-away one", () => {
    assert.equal(AGENT_INVENTORY_SOURCES.kimi.skillsDir, ".kimi-code/skills");
  });

  it("does not claim Codex has skills", () => {
    assert.equal(AGENT_INVENTORY_SOURCES.codex.skillsDir, undefined);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `make build-packages && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: FAIL — `AGENT_INVENTORY_SOURCES` is not exported, or values are `.kimi/skills` / `.codex/skills`.

- [ ] **Step 3: Make the change**

In `agent-inventory.ts`, export the table and fix the two rows:

```ts
export const AGENT_INVENTORY_SOURCES: Record<AgentName, AgentInventorySource> = {
  claude: { skillsDir: ".claude/skills", mcpJson: [".claude.json", ".mcp.json"] },
  // Codex has no skills concept; it has plugins. Scanning .codex/skills implied
  // a capability that does not exist.
  codex: { mcpJson: [".codex/mcp.json"], mcpToml: [".codex/config.toml"] },
  pi: { skillsDir: ".pi/skills", mcpJson: [".pi/mcp.json"] },
  // ~/.kimi holds a .migrated-to-kimi-code marker; .kimi-code is the live home.
  kimi: { skillsDir: ".kimi-code/skills", mcpJson: [".kimi-code/mcp.json"] },
};
```

Then `index.ts:1216`:

```ts
const LOCAL_AGENT_SKILL_DIRS = [".claude/skills", ".pi/skills", ".kimi-code/skills"];
```

And in `box.ts:258`, replace `"/home/agent/.kimi/skills"` with `"/home/agent/.kimi-code/skills"`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make build-packages && node --test dist/packages/relay-daemon/tests/daemon.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-daemon/src/agent-inventory.ts packages/relay-daemon/src/index.ts packages/relay-daemon/src/box.ts packages/relay-daemon/tests/daemon.test.ts
git commit -m "fix(daemon): scan Kimi's live skills dir and stop claiming Codex has skills"
```

---

### Task 2: Skill catalog store

**Files:**
- Create: `backend/relay/persistence/skill_store.py`
- Create: `backend/migrations/versions/20260914_0070_add_skill_catalog.py`
- Test: `backend/tests/unit/test_skill_store.py`

Follow the `DatabaseProjectStore` shape in `backend/relay/persistence/project_store.py`: a `SkillValidationError(ValueError)` with a `code`, table definitions on the shared metadata, `store_transaction` for writes, and `_skill_row` / `_skill_event` helpers.

**Interfaces:**
- Consumes: `backend/relay/persistence/store_common.py` (`shared_engine`, `store_transaction`, `json_type`, `entity_uuid_type`, `metadata`).
- Produces, used by Tasks 3-6 and 8:

```python
class SkillValidationError(ValueError):
    def __init__(self, code: str, message: str | None = None): ...

class DatabaseSkillStore:
    def create_skill(self, owner_employee_id: str, payload: dict[str, Any]) -> dict[str, Any]
    def add_revision(self, skill_id: str, created_by_employee_id: str,
                     files: list[dict[str, Any]], note: str | None = None) -> dict[str, Any]
    def get_skill(self, skill_id: str) -> dict[str, Any] | None
    def list_skills(self, viewer_employee_id: str) -> list[dict[str, Any]]
    def update_skill(self, skill_id: str, patch: dict[str, Any]) -> dict[str, Any]
    def delete_skill(self, skill_id: str) -> dict[str, Any]
    def get_revision(self, revision_id: str) -> dict[str, Any] | None
    def revision_files(self, revision_id: str) -> list[dict[str, Any]]
    def blob(self, sha256: str) -> bytes | None
```

`files` entries are `{"path": str, "content": bytes}`. A skill dict carries `id`, `ownerEmployeeId`, `namespace`, `name`, `slug`, `displayName`, `description`, `visibility`, `source`, `sourceRef`, `currentRevisionId`, `createdAt`, `updatedAt`, `deletedAt`. A revision dict carries `id`, `skillId`, `revision`, `manifestSha256`, `bytes`, `createdAt`, `createdByEmployeeId`, `note`.

Caps as module constants: `MAX_FILES = 300`, `MAX_FILE_BYTES = 1_048_576`, `MAX_REVISION_BYTES = 4_194_304`.

- [ ] **Step 1: Write the failing tests**

```python
from __future__ import annotations

import pytest
from relay.persistence.skill_store import DatabaseSkillStore, SkillValidationError


def _store(tmp_path) -> DatabaseSkillStore:
    return DatabaseSkillStore(f"sqlite:///{tmp_path}/relay-sessions.db", create_schema=True)


def _files(body: bytes = b"---\nname: review\ndescription: Reviews code\n---\nBody") -> list[dict]:
    return [{"path": "SKILL.md", "content": body}]


def test_create_skill_makes_first_revision(tmp_path):
    store = _store(tmp_path)
    skill = store.create_skill("alice", {"name": "review", "description": "Reviews code",
                                         "visibility": "private", "source": "authored",
                                         "files": _files()})
    assert skill["slug"] == "review"
    assert skill["currentRevisionId"]
    revision = store.get_revision(skill["currentRevisionId"])
    assert revision["revision"] == 1


def test_revisions_are_immutable_and_increment(tmp_path):
    store = _store(tmp_path)
    skill = store.create_skill("alice", {"name": "review", "description": "d",
                                         "visibility": "private", "source": "authored",
                                         "files": _files()})
    first = skill["currentRevisionId"]
    updated = store.add_revision(skill["id"], "alice", _files(b"---\nname: review\ndescription: d\n---\nNew"))
    assert store.get_revision(updated["currentRevisionId"])["revision"] == 2
    # The old revision still resolves to its original bytes.
    assert store.revision_files(first)[0]["content"] == _files()[0]["content"]


def test_manifest_sha_is_order_independent(tmp_path):
    store = _store(tmp_path)
    a = store.create_skill("alice", {"name": "a", "description": "d", "visibility": "private",
                                     "source": "authored",
                                     "files": [{"path": "SKILL.md", "content": b"x"},
                                               {"path": "refs/b.md", "content": b"y"}]})
    b = store.create_skill("alice", {"name": "b", "description": "d", "visibility": "private",
                                     "source": "authored",
                                     "files": [{"path": "refs/b.md", "content": b"y"},
                                               {"path": "SKILL.md", "content": b"x"}]})
    assert (store.get_revision(a["currentRevisionId"])["manifestSha256"]
            == store.get_revision(b["currentRevisionId"])["manifestSha256"])


def test_slug_is_unique_org_wide_across_owners(tmp_path):
    store = _store(tmp_path)
    store.create_skill("alice", {"name": "review", "description": "d", "visibility": "org",
                                 "source": "authored", "files": _files()})
    bob = store.create_skill("bob", {"name": "review", "description": "d", "visibility": "org",
                                     "source": "authored", "files": _files(),
                                     "ownerHandle": "bob"})
    assert bob["slug"] == "review-bob"


def test_skill_md_is_required(tmp_path):
    store = _store(tmp_path)
    with pytest.raises(SkillValidationError) as excinfo:
        store.create_skill("alice", {"name": "review", "description": "d", "visibility": "private",
                                     "source": "authored",
                                     "files": [{"path": "refs/only.md", "content": b"x"}]})
    assert excinfo.value.code == "skill-md-required"


@pytest.mark.parametrize(
    "files,code",
    [
        ([{"path": "SKILL.md", "content": b"x" * 1_048_577}], "file-too-large"),
        ([{"path": f"refs/{i}.md", "content": b"x"} for i in range(301)], "too-many-files"),
        ([{"path": "../escape.md", "content": b"x"}], "invalid-path"),
        ([{"path": "/abs.md", "content": b"x"}], "invalid-path"),
    ],
)
def test_publish_caps_and_path_safety(tmp_path, files, code):
    store = _store(tmp_path)
    if code != "too-many-files":
        files = files + [{"path": "SKILL.md", "content": b"x"}] if files[0]["path"] != "SKILL.md" else files
    with pytest.raises(SkillValidationError) as excinfo:
        store.create_skill("alice", {"name": "n", "description": "d", "visibility": "private",
                                     "source": "authored", "files": files})
    assert excinfo.value.code == code


def test_soft_delete_frees_the_slug(tmp_path):
    store = _store(tmp_path)
    skill = store.create_skill("alice", {"name": "review", "description": "d", "visibility": "org",
                                         "source": "authored", "files": _files()})
    store.delete_skill(skill["id"])
    again = store.create_skill("alice", {"name": "review", "description": "d", "visibility": "org",
                                         "source": "authored", "files": _files()})
    assert again["slug"] == "review"


def test_list_skills_shows_own_private_and_all_org(tmp_path):
    store = _store(tmp_path)
    store.create_skill("alice", {"name": "mine", "description": "d", "visibility": "private",
                                 "source": "authored", "files": _files()})
    store.create_skill("bob", {"name": "theirs", "description": "d", "visibility": "private",
                               "source": "authored", "files": _files()})
    store.create_skill("bob", {"name": "shared", "description": "d", "visibility": "org",
                               "source": "authored", "files": _files()})
    names = {skill["name"] for skill in store.list_skills("alice")}
    assert names == {"mine", "shared"}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_store.py -v`
Expected: FAIL — `ModuleNotFoundError: relay.persistence.skill_store`.

- [ ] **Step 3: Implement the store**

Three tables on the shared metadata: `skills`, `skill_revisions`, `skill_files`. Blobs are content-addressed — `skill_files` holds `(revision_id, path, sha256, bytes)` and a separate `skill_blobs(sha256 PRIMARY KEY, content)` holds bytes once, so two revisions that share a file store it once. Key logic:

```python
MAX_FILES = 300
MAX_FILE_BYTES = 1_048_576
MAX_REVISION_BYTES = 4_194_304
_SAFE_PATH = re.compile(r"^(?!\.)[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$")


def _validate_files(files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(files) > MAX_FILES:
        raise SkillValidationError("too-many-files")
    total = 0
    seen: set[str] = set()
    for entry in files:
        path = entry["path"]
        if path.startswith("/") or ".." in path.split("/") or not _SAFE_PATH.match(path):
            raise SkillValidationError("invalid-path", path)
        if path in seen:
            raise SkillValidationError("duplicate-path", path)
        seen.add(path)
        size = len(entry["content"])
        if size > MAX_FILE_BYTES:
            raise SkillValidationError("file-too-large", path)
        total += size
    if total > MAX_REVISION_BYTES:
        raise SkillValidationError("revision-too-large")
    if "SKILL.md" not in seen:
        raise SkillValidationError("skill-md-required")
    return sorted(files, key=lambda entry: entry["path"])


def _manifest_sha256(files: list[dict[str, Any]]) -> str:
    digest = hashlib.sha256()
    for entry in sorted(files, key=lambda item: item["path"]):
        digest.update(entry["path"].encode())
        digest.update(b"\0")
        digest.update(hashlib.sha256(entry["content"]).hexdigest().encode())
        digest.update(b"\n")
    return digest.hexdigest()
```

Slug allocation, called inside the create transaction so the uniqueness check and the insert cannot race:

```python
def _allocate_slug(conn, namespace: str | None, name: str, owner_handle: str | None) -> str:
    base = f"{namespace}/{name}" if namespace else name
    for candidate in _slug_candidates(base, owner_handle):
        taken = conn.execute(
            sa.select(skills_table.c.id).where(
                skills_table.c.slug == candidate,
                skills_table.c.deleted_at.is_(None),
            )
        ).first()
        if taken is None:
            return candidate
    raise SkillValidationError("slug-unavailable", base)


def _slug_candidates(base: str, owner_handle: str | None):
    yield base
    if owner_handle:
        yield f"{base}-{owner_handle}"
    for suffix in range(2, 50):
        yield f"{base}-{suffix}"
```

`list_skills(viewer)` filters `deleted_at IS NULL AND (visibility = 'org' OR owner_employee_id = :viewer)`. `delete_skill` sets `deleted_at`; nothing is physically removed, so a dangling grant can still be explained.

- [ ] **Step 4: Write the migration**

`backend/migrations/versions/20260914_0070_add_skill_catalog.py`, `revision = "20260914_0070"`, `down_revision = "20260913_0069"`. Create `skills` (unique index on `slug` where `deleted_at IS NULL`; unique index on `(owner_employee_id, namespace, name)` where `deleted_at IS NULL`), `skill_revisions` (unique on `(skill_id, revision)`), `skill_files` (unique on `(revision_id, path)`), `skill_blobs`. No data backfill — an empty `skillPolicy` is already a valid v1 grant set.

- [ ] **Step 5: Run tests and the migration**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_store.py -v`
Expected: PASS.
Run: `make backend-migrate`
Expected: upgrades to `20260914_0070` with no error.

- [ ] **Step 6: Commit**

```bash
git add backend/relay/persistence/skill_store.py backend/migrations/versions/20260914_0070_add_skill_catalog.py backend/tests/unit/test_skill_store.py
git commit -m "feat(backend): add skill catalog store with revisioned bundles"
```

---

### Task 3: Catalog HTTP surface

**Files:**
- Create: `backend/relay/api/skill_routes.py`
- Modify: `backend/relay/api/deps.py:31-44` (add `skill_store` to the context and the builder)
- Modify: `backend/relay/app.py:20-34, 374-383` (import and register the router)
- Test: `backend/tests/api/test_skill_routes.py`

Follow `backend/relay/api/project_routes.py` for router shape and `backend/tests/api/test_project_routes.py` for the test harness (`_bootstrap` creates an admin and employee `alice`).

**Interfaces:**
- Consumes: `DatabaseSkillStore` from Task 2.
- Produces, used by Tasks 6 and 11:
  - `POST /api/v1/skills` → `201` with the skill dict
  - `GET /api/v1/skills` → `{"skills": [...]}` scoped to the caller
  - `GET /api/v1/skills/{id}` → skill plus `revisions` and the current `files` manifest (paths and digests, no content)
  - `POST /api/v1/skills/{id}/revisions` → `201`
  - `PATCH /api/v1/skills/{id}` → `200` (`displayName`, `description`, `visibility`)
  - `DELETE /api/v1/skills/{id}` → `204`

Uploads arrive as JSON with base64 content: `{"files": [{"path": "SKILL.md", "contentBase64": "..."}]}`. `SkillValidationError` maps to `422`, except the size codes (`file-too-large`, `too-many-files`, `revision-too-large`) which map to `413`.

- [ ] **Step 1: Write the failing tests**

```python
def test_publish_and_list_skill(client):
    _bootstrap(client)
    response = client.post("/api/v1/skills", json={
        "name": "review", "description": "Reviews code", "visibility": "private",
        "files": [{"path": "SKILL.md", "contentBase64": _b64(b"---\nname: review\ndescription: d\n---\nB")}],
    })
    assert response.status_code == 201
    assert response.json()["slug"] == "review"
    assert [skill["name"] for skill in client.get("/api/v1/skills").json()["skills"]] == ["review"]


def test_private_skill_is_invisible_to_other_employees(client, app):
    _bootstrap(client)
    skill_id = _publish(client, name="secret", visibility="private")["id"]
    _login(client, "bob")
    assert client.get("/api/v1/skills").json()["skills"] == []
    # 404, not 403: a private skill must not leak its existence.
    assert client.get(f"/api/v1/skills/{skill_id}").status_code == 404


def test_oversized_bundle_is_rejected_with_413(client):
    _bootstrap(client)
    response = client.post("/api/v1/skills", json={
        "name": "big", "description": "d", "visibility": "private",
        "files": [{"path": "SKILL.md", "contentBase64": _b64(b"x" * 1_048_577)}],
    })
    assert response.status_code == 413


def test_only_the_owner_can_patch_or_delete(client):
    _bootstrap(client)
    skill_id = _publish(client, name="shared", visibility="org")["id"]
    _login(client, "bob")
    assert client.patch(f"/api/v1/skills/{skill_id}", json={"description": "hijacked"}).status_code == 403
    assert client.delete(f"/api/v1/skills/{skill_id}").status_code == 403


def test_new_revision_bumps_current(client):
    _bootstrap(client)
    skill_id = _publish(client, name="review", visibility="private")["id"]
    assert client.post(f"/api/v1/skills/{skill_id}/revisions", json={
        "files": [{"path": "SKILL.md", "contentBase64": _b64(b"---\nname: review\ndescription: d\n---\nV2")}],
    }).status_code == 201
    detail = client.get(f"/api/v1/skills/{skill_id}").json()
    assert detail["revisions"][0]["revision"] == 2
```

`_publish` is a local helper wrapping `POST /api/v1/skills` with a valid one-file bundle; `_login` switches the session to another employee; `_b64` is `base64.b64encode(...).decode()`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_skill_routes.py -v`
Expected: FAIL — `404` on every route, since the router is not registered.

- [ ] **Step 3: Implement the router and wire it**

Add `skill_store: SkillStore` to the `AppContext` dataclass in `deps.py` and to the builder below it (`skill_store=request.app.state.skill_store`), construct the store in `app.py` where the other stores are built, then register `skill_routes.router` in the `include_router` list **before** `web_routes.router` — the web catch-all is registered last so explicit API routes take precedence.

Authorization helper used by every route:

```python
def _visible_skill(ctx: AppContextDep, skill_id: str, employee_id: str) -> dict[str, Any]:
    skill = ctx.skill_store.get_skill(skill_id)
    if skill is None or skill["deletedAt"] is not None:
        raise HTTPException(status_code=404, detail="skill-not-found")
    if skill["visibility"] != "org" and skill["ownerEmployeeId"] != employee_id:
        # 404, not 403: a private skill must not leak its existence.
        raise HTTPException(status_code=404, detail="skill-not-found")
    return skill


def _owned_skill(ctx: AppContextDep, skill_id: str, employee_id: str) -> dict[str, Any]:
    skill = _visible_skill(ctx, skill_id, employee_id)
    if skill["ownerEmployeeId"] != employee_id:
        raise HTTPException(status_code=403, detail="not-skill-owner")
    return skill
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_skill_routes.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/api/skill_routes.py backend/relay/api/deps.py backend/relay/app.py backend/tests/api/test_skill_routes.py
git commit -m "feat(backend): add skill catalog routes"
```

---

### Task 4: Git import, fenced

The first outbound network call from the control plane. The guards are the deliverable; the fetch is incidental.

**Files:**
- Create: `backend/relay/services/skill_import.py`
- Modify: `backend/relay/persistence/org_settings_store.py` (add `skillImportAllowedHosts`, default `["github.com"]`)
- Modify: `backend/relay/api/skill_routes.py` (add `POST /api/v1/skills/import` and `POST /api/v1/skills/{id}/import`)
- Test: `backend/tests/unit/test_skill_import.py`

**Interfaces:**
- Produces:

```python
class SkillImportError(ValueError):
    def __init__(self, code: str, message: str | None = None): ...

def fetch_skill_bundle(url: str, ref: str, subpath: str | None,
                       *, allowed_hosts: list[str],
                       timeout_seconds: float = 30.0) -> list[dict[str, Any]]
```

Returns the same `[{"path", "content"}]` shape `DatabaseSkillStore.add_revision` takes, so import is just another way to make a revision.

- [ ] **Step 1: Write the failing tests**

```python
import pytest
from relay.services.skill_import import SkillImportError, fetch_skill_bundle

ALLOWED = ["github.com"]


@pytest.mark.parametrize("url,code", [
    ("http://github.com/o/r", "https-required"),
    ("https://evil.example.com/o/r", "host-not-allowed"),
    ("https://github.com@evil.example.com/o/r", "host-not-allowed"),
    ("file:///etc/passwd", "https-required"),
])
def test_rejects_disallowed_urls(url, code):
    with pytest.raises(SkillImportError) as excinfo:
        fetch_skill_bundle(url, "main", None, allowed_hosts=ALLOWED)
    assert excinfo.value.code == code


def test_rejects_hosts_resolving_to_private_ranges(monkeypatch):
    monkeypatch.setattr("relay.services.skill_import._resolve", lambda host: ["127.0.0.1"])
    with pytest.raises(SkillImportError) as excinfo:
        fetch_skill_bundle("https://github.com/o/r", "main", None, allowed_hosts=ALLOWED)
    assert excinfo.value.code == "private-address"


def test_rejects_archive_entries_that_escape(monkeypatch):
    monkeypatch.setattr("relay.services.skill_import._download_tarball",
                        lambda *a, **k: _tar({"../escape.md": b"x"}))
    with pytest.raises(SkillImportError) as excinfo:
        fetch_skill_bundle("https://github.com/o/r", "main", None, allowed_hosts=ALLOWED)
    assert excinfo.value.code == "invalid-path"


def test_rejects_symlink_entries(monkeypatch):
    monkeypatch.setattr("relay.services.skill_import._download_tarball",
                        lambda *a, **k: _tar_with_symlink("link.md", "/etc/passwd"))
    with pytest.raises(SkillImportError) as excinfo:
        fetch_skill_bundle("https://github.com/o/r", "main", None, allowed_hosts=ALLOWED)
    assert excinfo.value.code == "symlink-rejected"
```

Write `_tar` and `_tar_with_symlink` as local helpers building an in-memory `tarfile` — no network is touched by any test in this file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_import.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the guards, then the fetch**

Order matters: validate scheme → parse host with `urllib.parse` and compare the **parsed** host against the allowlist (never a substring match, which `https://github.com@evil.example.com` defeats) → resolve via `_resolve` and reject any address in a private, loopback, link-local, or reserved range using `ipaddress` → fetch the codeload tarball with a 30 s timeout, streaming with a hard byte ceiling → walk entries rejecting `issym`/`islnk`, absolute paths, and `..` → drop executable bits → apply the Task 2 caps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_import.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/services/skill_import.py backend/relay/persistence/org_settings_store.py backend/relay/api/skill_routes.py backend/tests/unit/test_skill_import.py
git commit -m "feat(backend): import skills from allowlisted git hosts"
```

---

### Task 5: Grant service on `skillPolicy`

`skillPolicy` (`backend/relay/persistence/agent_store.py:50`) exists and nothing reads it. This task gives it a typed v1 shape. It is the only module allowed to write that field.

**Files:**
- Create: `backend/relay/services/skill_grants.py`
- Test: `backend/tests/unit/test_skill_grants.py`

**Interfaces:**
- Consumes: `DatabaseSkillStore` (Task 2), `ctx.agent_store`.
- Produces, used by Tasks 6 and 8:

```python
GRANTS_VERSION = 1

class SkillGrantError(ValueError):
    def __init__(self, code: str, message: str | None = None): ...

def read_grants(agent: dict[str, Any]) -> list[dict[str, Any]]
def grant(ctx, skill_id: str, agent_ids: list[str], employee_id: str) -> list[dict[str, Any]]
def revoke(ctx, skill_id: str, agent_id: str, employee_id: str) -> dict[str, Any]
```

A grant entry is `{"skillId": str, "pin": "latest" | {"revisionId": str}, "grantedAt": iso8601, "grantedByEmployeeId": str}`.

Rules, all enforced here and nowhere else:
1. `read_grants` tolerates `{}` (today's value everywhere) and unknown keys, returning `[]`.
2. The caller must own every target agent (`supervisorEmployeeId == employee_id`) → else `not-agent-owner`.
3. The skill must be visible to the caller (own private, or any `org`) → else `skill-not-found`.
4. An agent whose `executorKind` is `codex` is refused → `executor-has-no-skills`. Codex has no skills concept; accepting the grant would be a lie.
5. Granting the same skill twice is idempotent — it updates `grantedAt`, never duplicates the entry.

- [ ] **Step 1: Write the failing tests**

```python
def test_read_grants_tolerates_legacy_empty_policy():
    assert read_grants({"skillPolicy": {}}) == []
    assert read_grants({"skillPolicy": {"version": 1, "unknownKey": 3, "grants": []}}) == []


def test_grant_writes_a_v1_entry(ctx, alice_agent, skill):
    grant(ctx, skill["id"], [alice_agent["id"]], "alice")
    stored = ctx.agent_store.get_agent(alice_agent["id"])
    assert stored["skillPolicy"]["version"] == 1
    entry = stored["skillPolicy"]["grants"][0]
    assert entry["skillId"] == skill["id"]
    assert entry["pin"] == "latest"
    assert entry["grantedByEmployeeId"] == "alice"


def test_granting_twice_is_idempotent(ctx, alice_agent, skill):
    grant(ctx, skill["id"], [alice_agent["id"]], "alice")
    grant(ctx, skill["id"], [alice_agent["id"]], "alice")
    assert len(read_grants(ctx.agent_store.get_agent(alice_agent["id"]))) == 1


def test_cannot_grant_to_an_agent_you_do_not_own(ctx, bob_agent, skill):
    with pytest.raises(SkillGrantError) as excinfo:
        grant(ctx, skill["id"], [bob_agent["id"]], "alice")
    assert excinfo.value.code == "not-agent-owner"


def test_cannot_grant_someone_elses_private_skill(ctx, alice_agent, bobs_private_skill):
    with pytest.raises(SkillGrantError) as excinfo:
        grant(ctx, bobs_private_skill["id"], [alice_agent["id"]], "alice")
    assert excinfo.value.code == "skill-not-found"


def test_codex_agents_are_refused(ctx, alice_codex_agent, skill):
    with pytest.raises(SkillGrantError) as excinfo:
        grant(ctx, skill["id"], [alice_codex_agent["id"]], "alice")
    assert excinfo.value.code == "executor-has-no-skills"


def test_revoke_removes_only_that_grant(ctx, alice_agent, skill, other_skill):
    grant(ctx, skill["id"], [alice_agent["id"]], "alice")
    grant(ctx, other_skill["id"], [alice_agent["id"]], "alice")
    revoke(ctx, skill["id"], alice_agent["id"], "alice")
    remaining = read_grants(ctx.agent_store.get_agent(alice_agent["id"]))
    assert [entry["skillId"] for entry in remaining] == [other_skill["id"]]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_grants.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the service**

Write grants with `agent_store.update_agent(agent_id, {"skillPolicy": new_policy})` — `skillPolicy` is already in `AGENT_PATCH_FIELDS` (`agent_store.py:50`) and in `PLACEMENT_RELEVANT_AGENT_FIELDS` (`agent_store.py:58`), so placements re-fingerprint with no extra work. Build the new policy immutably:

```python
def _with_grant(policy: dict[str, Any], entry: dict[str, Any]) -> dict[str, Any]:
    others = [g for g in _grants_of(policy) if g["skillId"] != entry["skillId"]]
    return {**policy, "version": GRANTS_VERSION, "grants": [*others, entry]}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_grants.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/services/skill_grants.py backend/tests/unit/test_skill_grants.py
git commit -m "feat(backend): grant skills to agents through skillPolicy"
```

---

### Task 6: Grant routes and the merged agent skill view

**Files:**
- Modify: `backend/relay/api/skill_routes.py` (two routes)
- Modify: `backend/relay/api/agent_routes.py:384-419` (`_agent_skills`)
- Test: `backend/tests/api/test_skill_grants_api.py`
- Test: `backend/tests/api/test_agent_api.py` (extend)

**Interfaces:**
- Consumes: `skill_grants.grant` / `revoke` / `read_grants` (Task 5).
- Produces:
  - `POST /api/v1/skills/{id}/grants` with `{"agentIds": [...]}` → `200 {"granted": [...]}`
  - `DELETE /api/v1/skills/{id}/grants/{agentId}` → `204`
  - `_agent_skills` entries gain `"source": "node" | "catalog"`; catalog entries also carry `skillId`, `slug`, and `available: bool`.

There is deliberately **no** `GET /agents/{id}/skills` route: the agent detail payload already carries `skills` (`agent_routes.py:380`), and a second endpoint answering the same question is how the two drift apart.

- [ ] **Step 1: Write the failing tests**

```python
def test_grant_appears_on_the_agent_payload(client):
    # publish, grant, then read the agent detail
    agent = client.get(f"/api/v1/agents/{agent_id}").json()
    catalog = [s for s in agent["skills"] if s["source"] == "catalog"]
    assert catalog[0]["slug"] == "review"
    assert catalog[0]["available"] is True


def test_node_reported_skills_are_still_listed_and_tagged(client):
    # register a node advertising inventory, then assert source == "node"
    assert any(s["source"] == "node" for s in agent["skills"])


def test_granting_to_a_codex_agent_is_422(client):
    response = client.post(f"/api/v1/skills/{skill_id}/grants", json={"agentIds": [codex_agent_id]})
    assert response.status_code == 422
    assert response.json()["detail"] == "executor-has-no-skills"


def test_deleted_skill_shows_as_unavailable_not_missing(client):
    client.delete(f"/api/v1/skills/{skill_id}")
    agent = client.get(f"/api/v1/agents/{agent_id}").json()
    entry = [s for s in agent["skills"] if s.get("skillId") == skill_id][0]
    assert entry["available"] is False


def test_revoke_removes_the_entry(client):
    assert client.delete(f"/api/v1/skills/{skill_id}/grants/{agent_id}").status_code == 204
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_skill_grants_api.py -v`
Expected: FAIL — routes return `404`; `skills` entries have no `source`.

- [ ] **Step 3: Implement**

Map `SkillGrantError` codes to status: `not-agent-owner` → `403`, `skill-not-found` → `404`, `executor-has-no-skills` → `422`. In `_agent_skills`, keep the existing node sweep exactly as it is, tag those entries `source: "node"`, then append the resolved grants tagged `source: "catalog"`. A grant whose skill is soft-deleted stays in the list with `available: False` — the user granted it and deserves to see why it stopped working, rather than watching it vanish.

- [ ] **Step 4: Run tests to verify they pass**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_skill_grants_api.py backend/tests/api/test_agent_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/api/skill_routes.py backend/relay/api/agent_routes.py backend/tests/api/test_skill_grants_api.py backend/tests/api/test_agent_api.py
git commit -m "feat(backend): dispatch skills to agents and merge them into the agent view"
```

---

### Task 7: Protocol, registry, and command builders

Teaches the shared runtime how each CLI receives skills. Verified against the installed binaries — do not change these values without re-running `--help`.

**Files:**
- Modify: `packages/relay-core/src/agents.ts` (`AgentDefinition` + all four entries)
- Modify: `packages/relay-core/src/state.ts:68` (add `skill_paths`)
- Modify: `packages/relay-core/src/commands.ts` (Pi and Kimi builders)
- Modify: `packages/relay-core/src/daemon-node-protocol.ts` (bundle type + capability)
- Test: `packages/relay-core/tests/handoff.test.ts`

**Interfaces:**
- Produces, used by Tasks 8-10:

```ts
export type SkillDelivery =
  | { kind: "config-dir"; envVar: string; subdir: string; skillsSubpath: string }
  | { kind: "skills-dir-flag"; flag: string }
  | { kind: "skill-path-flag"; flag: string }
  | { kind: "unsupported" };

// on AgentDefinition:
skillDelivery: SkillDelivery;

// on AgentState:
skill_paths?: string[];

export interface DaemonRunSkillBundle {
  contract: { name: "relay.agent.skills"; version: 1 };
  skills: Array<{
    skillId: string;
    revisionId: string;
    slug: string;
    manifestSha256: string;
    files: Array<{ path: string; sha256: string; bytes: number }>;
  }>;
}

export const DAEMON_CAPABILITY_AGENT_SKILLS: DaemonNodeCapability = "agent-skills";
```

Registry values:

| Agent | `skillDelivery` |
|---|---|
| claude | `{ kind: "config-dir", envVar: "CLAUDE_CONFIG_DIR", subdir: ".claude", skillsSubpath: "skills" }` |
| pi | `{ kind: "skill-path-flag", flag: "--skill" }` |
| kimi | `{ kind: "skills-dir-flag", flag: "--skills-dir" }` |
| codex | `{ kind: "unsupported" }` |

- [ ] **Step 1: Write the failing tests**

```ts
describe("skill delivery", () => {
  it("declares a delivery mechanism for every agent", () => {
    for (const name of AGENT_NAMES) {
      assert.ok(AGENT_REGISTRY[name].skillDelivery, `${name} has no skillDelivery`);
    }
    assert.equal(AGENT_REGISTRY.codex.skillDelivery.kind, "unsupported");
  });

  it("repeats Pi's --skill flag once per granted path", () => {
    const command = buildPiCommand(state({ skill_paths: ["/store/a", "/store/b"] }));
    assert.match(command, /--skill '\/store\/a'/);
    assert.match(command, /--skill '\/store\/b'/);
  });

  it("repeats Kimi's --skills-dir flag once per granted path", () => {
    const command = buildKimiCommand(state({ skill_paths: ["/store/a", "/store/b"] }));
    assert.match(command, /--skills-dir '\/store\/a'/);
    assert.match(command, /--skills-dir '\/store\/b'/);
  });

  it("emits no skill flags when nothing is granted", () => {
    assert.doesNotMatch(buildPiCommand(state({})), /--skill /);
    assert.doesNotMatch(buildKimiCommand(state({})), /--skills-dir/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make build-packages && node --test dist/packages/relay-core/tests/handoff.test.js`
Expected: FAIL — `skillDelivery` is not a property; no flags are emitted.

- [ ] **Step 3: Implement**

Add the field to `AgentDefinition` and all four registry entries (the `Record<AgentName, AgentDefinition>` type makes a missing one a compile error). In `commands.ts`, emit flags from `state.skill_paths`, shell-quoting each path with the existing quoting helper. Paths are absolute inside the node.

- [ ] **Step 4: Settle Pi's discovery question empirically**

The spec leaves one question open for this step, because the help text does not
answer it: does `--no-skills` suppress discovery while leaving explicit
`--skill` paths loaded? Its sibling `--no-extensions` documents exactly that
behavior ("explicit -e paths still work"), but the skills flag does not say so.

Run it and find out:

```bash
mkdir -p /tmp/skilltest/granted/demo
printf -- '---\nname: demo\ndescription: Demo skill\n---\nSay DEMO-LOADED.\n' > /tmp/skilltest/granted/demo/SKILL.md
pi --no-skills --skill /tmp/skilltest/granted/demo -p "List the skills you have loaded."
```

If the skill is loaded, add `--no-skills` to Pi's builder — Pi then gets the
same replace-discovery guarantee Kimi has, and isolation is exact. If it is
not, omit the flag: Pi's isolation is **additive** (granted skills load,
node-installed ones stay visible too), and Task 12's UI copy must not claim
otherwise. Record which way it went in a comment on the Pi registry entry.

- [ ] **Step 5: Run tests to verify they pass**

Run: `make build-packages && node --test dist/packages/relay-core/tests/handoff.test.js`
Expected: PASS. Confirm the existing assertions that no raw JSONL leaks still pass.

- [ ] **Step 6: Commit**

```bash
git add packages/relay-core/src/agents.ts packages/relay-core/src/state.ts packages/relay-core/src/commands.ts packages/relay-core/src/daemon-node-protocol.ts packages/relay-core/tests/handoff.test.ts
git commit -m "feat(core): declare per-agent skill delivery and emit skill flags"
```

---

### Task 8: Bundle resolution and the blob endpoint

**Files:**
- Create: `backend/relay/services/skill_bundle.py`
- Modify: `backend/relay/daemon_registry/node_backend.py` (attach `skills` to the run command)
- Modify: `backend/relay/api/daemon_node_routes.py` (blob endpoint)
- Test: `backend/tests/unit/test_skill_bundle.py`
- Test: `backend/tests/api/test_daemon_api.py` (extend)

**Interfaces:**
- Consumes: `skill_grants.read_grants` (Task 5), `DatabaseSkillStore` (Task 2).
- Produces:

```python
def resolve_bundle(ctx, agent: dict[str, Any]) -> tuple[dict[str, Any] | None, list[dict[str, str]]]
```

Returns `(bundle, skipped)`. `bundle` is the `DaemonRunSkillBundle` JSON shape from Task 7, or `None` when the agent has no usable grants. `skipped` entries are `{"skillId": ..., "reason": "deleted" | "revision-missing"}` and drive the Task 10 notice.

New route: `GET /daemon-nodes/{node_id}/skill-blobs/{sha256}?commandId=...` → `200` with `application/octet-stream`, or `404`.

- [ ] **Step 1: Write the failing tests**

```python
def test_resolves_latest_pin_to_the_current_revision(ctx, agent, skill):
    bundle, skipped = resolve_bundle(ctx, agent)
    assert skipped == []
    assert bundle["skills"][0]["revisionId"] == skill["currentRevisionId"]


def test_honors_a_pinned_revision_after_a_newer_one_exists(ctx, agent, skill):
    pinned = skill["currentRevisionId"]
    ctx.skill_store.add_revision(skill["id"], "alice", _files(b"---\nname: n\ndescription: d\n---\nV2"))
    _pin(ctx, agent, skill["id"], pinned)
    bundle, _ = resolve_bundle(ctx, agent)
    assert bundle["skills"][0]["revisionId"] == pinned


def test_skips_a_deleted_skill_and_reports_why(ctx, agent, skill):
    bundle, skipped = resolve_bundle(ctx, agent)
    assert bundle is None
    assert skipped == [{"skillId": skill["id"], "reason": "deleted"}]

def test_never_falls_back_to_latest_when_a_pin_is_missing(ctx, agent, skill):
    bundle, skipped = resolve_bundle(ctx, agent)
    assert bundle is None
    assert skipped[0]["reason"] == "revision-missing"

def test_bundle_carries_digests_but_never_content(ctx, agent, skill):
    bundle, _ = resolve_bundle(ctx, agent)
    entry = bundle["skills"][0]["files"][0]
    assert set(entry) == {"path", "sha256", "bytes"}

def test_blob_is_scoped_to_the_issuing_command(client, app):
    # A blob reachable from command A is 404 when requested with command B's id.
    assert client.get(f"/daemon-nodes/{node}/skill-blobs/{sha}?commandId={other}").status_code == 404

def test_blob_requires_the_daemon_token(client):
    assert client.get(f"/daemon-nodes/{node}/skill-blobs/{sha}?commandId={cmd}").status_code == 401
```

`_pin` rewrites the agent's grant entry to `{"revisionId": ...}`; `_files` is the same one-file helper used in Task 2.

- [ ] **Step 2: Run tests to verify they fail**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_bundle.py -v`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

`resolve_bundle` dedupes by `skillId` and sorts by `slug` so the manifest is stable run to run — an unstable manifest would defeat the daemon's installed-state comparison. In `node_backend.py`, call it where the run command is built and attach the result as `skills`; do **not** attach it when the node's capabilities lack `agent-skills`, and pass the skipped list through so Task 10 can report it.

Authorize the blob route against the issuing command's own manifest, not against the node: look up the command, confirm the requested `sha256` appears in one of its bundle entries' files. This is a single manifest lookup rather than a scan of every placement and grant on the node, and it is strictly narrower.

- [ ] **Step 4: Run tests to verify they pass**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_skill_bundle.py backend/tests/api/test_daemon_api.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/relay/services/skill_bundle.py backend/relay/daemon_registry/node_backend.py backend/relay/api/daemon_node_routes.py backend/tests/unit/test_skill_bundle.py backend/tests/api/test_daemon_api.py
git commit -m "feat(backend): resolve granted skills into run manifests and serve blobs"
```

---

### Task 9: Daemon-side materialization

The only task that touches the filesystem. Read the spec's **Concurrency** section before starting — the append-only store and the deferred prune are the whole point.

**Files:**
- Create: `packages/relay-daemon/src/agent-skills.ts`
- Modify: `packages/relay-daemon/src/index.ts` (call it before the CLI starts; advertise the capability at registration)
- Test: `packages/relay-daemon/tests/agent-skills.test.ts`

**Interfaces:**
- Consumes: `DaemonRunSkillBundle`, `SkillDelivery`, `DAEMON_CAPABILITY_AGENT_SKILLS` (Task 7); the blob endpoint (Task 8).
- Produces:

```ts
export interface MaterializedSkills {
  /** Absolute paths to pass as CLI flags. Empty for the config-dir kind. */
  skillPaths: string[];
  /** Env additions, e.g. CLAUDE_CONFIG_DIR. Empty for the flag kinds. */
  env: Record<string, string>;
  /** Slugs delivered on this run, in manifest order. */
  slugs: string[];
  /** Skills that could not be delivered, for the Task 10 notice. */
  skipped: Array<{ skillId: string; reason: string }>;
}

export async function materializeSkills(options: {
  bundle: DaemonRunSkillBundle | undefined;
  agentId: string;
  delivery: SkillDelivery;
  agentHome: string;
  cacheDir: string;
  fetchBlob(sha256: string): Promise<Buffer>;
}): Promise<MaterializedSkills>;
```

Layout, all under the node's agent home:
- `skills/.store/<manifestSha256>/` — unpacked revisions. **Append-only**, shared by every agent on the node.
- `<agentHome>/agents/agent-<base64url(agentId)>/.claude/` — Claude only; node `.claude` entries mirrored in by symlink **except** `skills/`, then `skills/<slug>` symlinked into the store.

- [ ] **Step 1: Write the failing tests**

```ts
describe("materializeSkills", () => {
  it("passes store paths as flags for Pi and writes no per-agent directory", async () => {
    const result = await materializeSkills({ ...base, delivery: { kind: "skill-path-flag", flag: "--skill" } });
    assert.equal(result.skillPaths.length, 1);
    assert.equal(existsSync(join(agentHome, "agents")), false);
  });

  it("links only granted slugs into Claude's per-agent config dir", async () => {
    const result = await materializeSkills({ ...base, delivery: claudeDelivery });
    assert.ok(result.env.CLAUDE_CONFIG_DIR);
    assert.deepEqual(readdirSync(join(result.env.CLAUDE_CONFIG_DIR, "skills")), ["review"]);
  });

  it("mirrors node config entries by symlink but never the node skills dir", async () => {
    writeFileSync(join(nodeClaude, ".credentials.json"), "{}");
    mkdirSync(join(nodeClaude, "skills", "not-granted"), { recursive: true });
    const result = await materializeSkills({ ...base, delivery: claudeDelivery });
    assert.ok(lstatSync(join(result.env.CLAUDE_CONFIG_DIR, ".credentials.json")).isSymbolicLink());
    assert.equal(existsSync(join(result.env.CLAUDE_CONFIG_DIR, "skills", "not-granted")), false);
    // The shared node directory is never written to.
    assert.ok(existsSync(join(nodeClaude, "skills", "not-granted")));
  });

  it("isolates two agents of the same kind on one node", async () => {
    const a = await materializeSkills({ ...base, agentId: "agent-a", bundle: bundleOf("review") });
    const b = await materializeSkills({ ...base, agentId: "agent-b", bundle: bundleOf("triage") });
    assert.deepEqual(readdirSync(join(a.env.CLAUDE_CONFIG_DIR, "skills")), ["review"]);
    assert.deepEqual(readdirSync(join(b.env.CLAUDE_CONFIG_DIR, "skills")), ["triage"]);
  });

  it("fetches each blob once and not at all on a repeat run", async () => {
    let fetches = 0;
    const counting = async (sha: string) => { fetches += 1; return blobs[sha]; };
    await materializeSkills({ ...base, fetchBlob: counting });
    const afterFirst = fetches;
    await materializeSkills({ ...base, fetchBlob: counting });
    assert.equal(fetches, afterFirst, "second run must hit the cache");
  });

  it("stores one copy when two agents get the same revision", async () => {
    await materializeSkills({ ...base, agentId: "agent-a" });
    await materializeSkills({ ...base, agentId: "agent-b" });
    assert.equal(readdirSync(join(agentHome, "skills", ".store")).length, 1);
  });

  it("does not delete a slug another in-flight run is using", async () => {
    const [a, b] = await Promise.all([
      materializeSkills({ ...base, agentId: "agent-a", bundle: bundleOf("review") }),
      materializeSkills({ ...base, agentId: "agent-a", bundle: bundleOf("review", "triage") }),
    ]);
    for (const result of [a, b]) {
      for (const slug of result.slugs) {
        assert.ok(existsSync(join(result.env.CLAUDE_CONFIG_DIR, "skills", slug)));
      }
    }
  });

  it("is a no-op when no bundle is present", async () => {
    const result = await materializeSkills({ ...base, bundle: undefined });
    assert.deepEqual(result, { skillPaths: [], slugs: [], env: {}, skipped: [] });
  });

  it("reports a failed blob fetch as skipped instead of throwing", async () => {
    const result = await materializeSkills({ ...base, fetchBlob: async () => { throw new Error("offline"); } });
    assert.equal(result.skipped[0].reason, "blob-fetch-failed");
    assert.deepEqual(result.skillPaths, []);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `make build-packages && node --test dist/packages/relay-daemon/tests/agent-skills.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Unpack to a temporary directory and `rename` it into `skills/.store/<manifestSha256>/` — `rename` is atomic, so two runs racing on the same revision converge instead of tearing. If the destination already exists, discard the temporary copy; that is the cache hit. For Claude, create each `skills/<slug>` link by writing a temporary link and renaming over it, so a concurrent run sees the old target or the new one, never a half-written directory. **Prune only symlinks, and only those absent from every manifest currently in flight for that agent** — keep an in-process set of active manifests keyed by agent id. Never sweep `.store` during a run.

Wrap the whole thing in try/catch: any failure becomes a `skipped` entry, never a thrown error. A missing skill degrades capability; it must not destroy work in progress.

Finally, add `"agent-skills"` to the capability list the daemon advertises at registration.

- [ ] **Step 4: Run tests to verify they pass**

Run: `make build-packages && node --test dist/packages/relay-daemon/tests/agent-skills.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-daemon/src/agent-skills.ts packages/relay-daemon/src/index.ts packages/relay-daemon/tests/agent-skills.test.ts
git commit -m "feat(daemon): materialize granted skills per agent at dispatch"
```

---

### Task 10: Never run silently without a granted skill

**Files:**
- Modify: `packages/relay-core/src/daemon-node-protocol.ts` (`skillsSkipped` on `run.executing`)
- Modify: `packages/relay-daemon/src/index.ts` (report what materialization skipped)
- Modify: `backend/relay/sessions/controller.py` (record it and emit a system notice)
- Test: `backend/tests/api/test_session_stream.py` (extend)
- Test: `packages/relay-daemon/tests/agent-skills.test.ts` (extend)

**Interfaces:**
- Consumes: `MaterializedSkills.skipped` (Task 9), `resolve_bundle`'s `skipped` (Task 8).
- Produces: a `skillsSkipped: Array<{ skillId: string; slug?: string; reason: string }>` field on the `run.executing` event, and a thread system notice naming each skill and reason.

Reasons, all four surfaced with distinct copy: `deleted`, `revision-missing`, `blob-fetch-failed`, `daemon-unsupported`.

- [ ] **Step 1: Write the failing test**

```python
def test_thread_shows_a_notice_when_a_granted_skill_was_not_delivered(client):
    # Dispatch to a node whose capabilities omit "agent-skills".
    events = _stream(client, session_id)
    notice = [e for e in events if e["type"] == "system.notice"][0]
    assert "review" in notice["text"]
    assert "daemon-unsupported" in notice["reason"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_session_stream.py -v`
Expected: FAIL — no notice is emitted.

- [ ] **Step 3: Implement**

The backend already knows the `daemon-unsupported` case at dispatch (Task 8) and learns the rest from `run.executing`. Emit one notice per run listing every skipped skill, not one per skill.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: PASS, whole suite.

- [ ] **Step 5: Commit**

```bash
git add packages/relay-core/src/daemon-node-protocol.ts packages/relay-daemon/src/index.ts backend/relay/sessions/controller.py backend/tests/api/test_session_stream.py packages/relay-daemon/tests/agent-skills.test.ts
git commit -m "feat: report skills a run could not load"
```

---

### Task 11: Skills library surface

**Files:**
- Create: `web/src/components/SkillsPage.tsx`
- Modify: `web/src/App.tsx:715` (route branch), `web/src/components/SideNav.tsx:235-247` (nav entry)
- Modify: `web/src/types.ts` (`CatalogSkill`, `SkillRevision`)
- Modify: `web/src/i18n/*` (`skills_page.*` keys)
- Test: `web/tests/skillsPage.test.ts`

Follow the list-rail-plus-detail-record grammar the threads, projects, agents, and teams rails already use — one row contract, the record band on every tab, no tab restating a band fact. Colors come from `palette.css` only; the type scale and radius scale are the console ones, not the marketing scale.

**Interfaces:**
- Consumes: `GET /api/v1/skills`, `GET /api/v1/skills/{id}` (Task 3).
- Produces: `SkillsPage`, and a `CatalogSkill` type mirroring the store's skill dict.

- [ ] **Step 1: Write the failing tests**

```ts
describe("SkillsPage", () => {
  it("renders one row per skill with its visibility and grant count", () => {
    const rows = renderRows([
      { id: "1", name: "review", slug: "review", visibility: "org", grantedAgentCount: 2 },
      { id: "2", name: "triage", slug: "triage", visibility: "private", grantedAgentCount: 0 },
    ]);
    assert.deepEqual(rows.map((row) => row.label), ["review", "triage"]);
    assert.equal(rows[0].visibilityPill, "Shared with org");
    assert.equal(rows[1].visibilityPill, "Private");
  });

  it("shows the empty state when the catalog has no skills", () => {
    assert.match(renderEmpty(), /No skills yet/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/tests/skillsPage.test.ts`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement**

Rail row: name, namespace, visibility pill, granted-agent count. Detail tabs: Overview (description, source, current revision, file tree), Revisions, Agents. Add the nav entry beside the existing `agents` one, copying its `aria-current` / tooltip / `hrefForRoute` handling exactly.

When seeding query data, never `setQueryData([])` on a cache a loading state reads — it forges `isPending`/`isFetchedAfterMount` and the loading state goes dead. Let the query fetch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run web/tests/skillsPage.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SkillsPage.tsx web/src/App.tsx web/src/components/SideNav.tsx web/src/types.ts web/src/i18n web/tests/skillsPage.test.ts
git commit -m "feat(web): add the skills library"
```

---

### Task 12: Share drawer and the agent panel split

**Files:**
- Create: `web/src/components/ShareSkillDrawer.tsx`
- Modify: `web/src/components/AgentProfilePanel.tsx:242, 307-322`
- Test: `web/tests/shareSkillDrawer.test.ts`
- Test: `web/tests/agentSkills.test.ts`

**Interfaces:**
- Consumes: `POST /api/v1/skills/{id}/grants`, `DELETE /api/v1/skills/{id}/grants/{agentId}` (Task 6); the merged `agent.skills` array with `source` / `available` (Task 6).
- Produces: `ShareSkillDrawer`, reusing the existing tabbed agent/team roster picker rather than a second picker.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ShareSkillDrawer", () => {
  it("excludes Codex agents and says why", () => {
    const view = renderPicker([
      { id: "a", name: "Ada", executorKind: "claude" },
      { id: "c", name: "Cy", executorKind: "codex" },
    ]);
    assert.deepEqual(view.selectable.map((a) => a.id), ["a"]);
    assert.match(view.excludedReason, /Codex does not support skills/);
  });

  it("fans a team selection out to one grant per member agent", () => {
    assert.deepEqual(grantPayloadFor({ teamId: "t1" }), { agentIds: ["a", "b"] });
  });
});

describe("AgentProfilePanel skills", () => {
  it("groups granted skills apart from machine-installed ones", () => {
    const groups = renderSkillGroups([
      { name: "review", source: "catalog", available: true },
      { name: "local", source: "node" },
    ]);
    assert.deepEqual(Object.keys(groups), ["Granted", "Installed on this computer"]);
  });

  it("marks a revoked grant as taking effect at the next run", () => {
    const view = renderSkillGroups([{ name: "review", source: "catalog", available: false }]);
    assert.match(view.Granted[0].note, /next run/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run web/tests/shareSkillDrawer.test.ts web/tests/agentSkills.test.ts`
Expected: FAIL — component does not exist; the panel renders one flat list.

- [ ] **Step 3: Implement**

Filter Codex agents out of the picker with the reason shown, rather than leaving them selectable and inert — the API refuses them anyway (Task 5), and a control that always fails is worse than an absent one. A team pick expands to its member agents at grant time so a later membership change cannot silently widen access.

Rewrite the copy at `AgentProfilePanel.tsx:307`. It currently says installing happens on the machine; that is still true for the node group and now false for the granted group, so each group gets its own line. The granted group says plainly that revoking takes effect at the agent's next run — a user who reads "revoke" as "cut off now" is wrong, and the UI is where that gets corrected.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ShareSkillDrawer.tsx web/src/components/AgentProfilePanel.tsx web/tests/shareSkillDrawer.test.ts web/tests/agentSkills.test.ts
git commit -m "feat(web): share a skill to chosen agents"
```

---

## Definition of done

- [ ] `npm test` and `make backend-test` both green.
- [ ] `make backend-migrate` reaches `20260914_0070`.
- [ ] A skill published in the web UI, granted to one Claude agent on a node that also hosts a second Claude agent, is present for the first and absent for the second — verified on a real node, not only in tests.
- [ ] Granting to a Codex agent is impossible in the UI and refused by the API.
- [ ] A run dispatched to a daemon without `agent-skills` completes and says in the thread which skills it lacked.
