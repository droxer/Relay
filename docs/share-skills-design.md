# Published Skills — Architecture

**Date:** 2026-09-15
**Status:** Implemented baseline
**Branch:** `droxer/skill-enhancement`

## Summary

Relay stores a published skill once in the control plane and resolves who
receives it at dispatch time. A publication is not copied into every agent
record. Assignments target an employee, team, project, agent, or the
organization, so membership changes automatically affect later runs.

The design follows the useful parts of other agent platforms: a central
catalog, user and workspace scopes, immutable portable bundles, explicit
version selection, and administrative organization scope. Relay keeps its own
stronger execution boundary: the backend never runs an agent and daemons only
receive the exact revisions authorized for one command.

## Model

The four concepts are deliberately separate:

1. **Publication** — identity, ownership, visibility, source, and revision
   pointers for a catalog entry.
2. **Revision** — an immutable manifest of paths and content digests.
3. **Assignment** — the target scope, delivery requirement, invocation policy,
   and revision pin.
4. **Materialization** — a command-scoped daemon view assembled immediately
   before execution.

Visibility answers who may discover a publication. Assignment answers where it
is available. Neither implies the other.

### Assignment scopes

| Scope | Meaning |
|---|---|
| `employee` | Every current and future agent owned by that employee |
| `team` | Agents currently in the team |
| `project` | The lead and enabled project members, only for runs in that project |
| `agent` | One logical agent |
| `org` | Every employee agent; administrator-only to assign |

More specific scopes override less specific scopes for the same publication:
`org < employee < team < project < agent`. Assignments are evaluated on every
dispatch; Relay does not fan them out into per-agent grants.

### Assignment policy

- `mode`: `optional`, `required`, or `suggested`.
- `invocation`: `implicit` or `explicit`. Suggested assignments must be
  explicit and are not automatically materialized.
- `pin`: `stable`, `latest`, or an exact `{revisionId}`.

Optional failures produce a thread notice and allow the run to continue.
Required failures block dispatch or daemon execution. This includes a missing
revision, lost visibility, unsupported daemon capability, failed blob fetch,
or invalid materialization.

## Agent Skills specification

Published bundles conform to the Agent Skills specification:

- Names are lowercase hyphen-separated identifiers of at most 64 characters.
- `SKILL.md` requires `name` and `description`; supported optional frontmatter
  is validated by type and length and unknown fields are rejected.
- The installed directory leaf always matches the frontmatter name.
- Catalog collisions add a parent namespace such as `alice/code-review`; they
  never rewrite the leaf into a nonconforming name.
- Pi receives paths from a named immutable run view rather than hash-named
  content-store directories.

The full compliance evidence is in
`docs/testing/agent-skills-spec-compliance.tdd.md`.

## Storage

Catalog metadata, immutable revision manifests, assignments, and their events
live in the configured database. Bundle bytes use a storage abstraction:

```text
<relay-state>/skills/objects/<sha256[0:2]>/<sha256[2:]>
```

The initial implementation is `LocalSkillObjectStore`. Objects are addressed
by SHA-256, written atomically, created with mode `0600`, and verified on read.
The database stores the digest and byte count, not new blob content. A nullable
legacy content column remains temporarily so upgraded installations can read
objects published by older builds.

`SkillObjectStore` is the extension seam for a later S3-compatible or other
object-storage implementation; catalog and dispatch code do not depend on the
filesystem layout.

Limits are enforced before publication: 300 files, 1 MiB per file, and 4 MiB
per revision. Paths must be confined relative paths, `SKILL.md` is required,
and manifest frontmatter must agree with the catalog name.

## Revisions and portability

Every edit, upload, or re-import creates a new immutable revision.

- `currentRevisionId` is the newest revision (`latest`).
- `stableRevisionId` is initialized to revision 1 and changes only through an
  explicit promotion.
- Exact revision pins never float.

`GET /api/v1/skills/{id}/export?channel=stable|latest` returns a portable ZIP
containing the original bundle paths. Export reads through the object-store
interface and is subject to the same visibility rules as catalog detail.

## API

Catalog:

- `GET /api/v1/skills`
- `POST /api/v1/skills`
- `POST /api/v1/skills/import`
- `GET /api/v1/skills/{id}`
- `PATCH /api/v1/skills/{id}`
- `DELETE /api/v1/skills/{id}`
- `POST /api/v1/skills/{id}/revisions`
- `POST /api/v1/skills/{id}/revisions/{revisionId}/promote`
- `POST /api/v1/skills/{id}/import`
- `GET /api/v1/skills/{id}/export`

Assignments:

- `POST /api/v1/skills/{id}/assignments`
- `DELETE /api/v1/skills/{id}/assignments/{assignmentId}`

The older per-agent grant endpoints remain as a compatibility layer. Direct
v1 grants override inherited assignments for the same skill during migration;
new web flows create scoped assignments.

## Dispatch and daemon isolation

The backend resolves effective assignments to immutable revision manifests.
Run commands carry paths, byte counts, and digests only. A daemon fetches a blob
only when it is absent from its verified content-addressed cache. The blob
endpoint authenticates the daemon and checks that the digest belongs to that
specific command.

Each run gets an immutable skill view. Claude and Codex receive isolated config
directories; Pi receives explicit `--skill` paths with discovery disabled;
Kimi receives an isolated `--skills-dir`. Codex skill delivery is supported.
Unassigned node-local skills remain separate inventory and are never presented
as Relay-managed assignments.

## Authorization and governance boundary

- Owners may revise, promote, update, and delete their publications; visible
  publications may be exported.
- A caller may assign a visible publication only to a target they own.
- Organization assignments require an administrator.
- Private publications remain usable only by their owner targets; `org`
  visibility enables discovery and assignment by other employees.
- Soft deletion and immutable events keep historical failures explainable.

Approval workflows, scanning attestations, quarantine, and cross-organization
marketplaces are intentionally later governance layers. The assignment and
stable-channel model is designed so those checks can be inserted before
promotion or dispatch without changing daemon delivery.

## Object-storage extension

When Relay adds remote object storage, implement the existing
`SkillObjectStore` protocol and select it in `skill_store_from_env`. Required
properties are content-addressed keys, atomic visibility after a successful
put, digest verification, bounded reads, and no public object URLs. Database
events and revision manifests remain authoritative.
