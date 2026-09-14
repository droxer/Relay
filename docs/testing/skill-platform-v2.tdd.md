# Published Skills v2 — TDD Evidence

## Red checkpoints

- `ec0d9ad0` — file-backed object storage and scoped assignment contracts.
- `412524e6` — dispatch resolves assignments rather than copied agent grants.
- `b1436b04` — authenticated scoped assignment API.
- `08064814` — stable promotion and portable export.
- `db0cb71c` — required delivery guarantees.
- `e9ec0a34` — web assignment contract and scope picker.

Each checkpoint was executed before its production implementation and failed
for the missing behavior.

## Green coverage

- Local object writes are content-addressed, atomic, permission-restricted,
  deduplicated, and digest-verified.
- Existing database blobs remain readable during migration.
- Employee, team, project, agent, and organization assignment ownership and
  precedence are covered by service tests.
- Employee assignments dynamically reach existing and future agents through
  API-to-dispatch tests.
- Stable pins do not float when a new revision is published; explicit
  promotion changes the channel.
- Portable ZIP export contains the selected immutable revision.
- Required resolution and materialization failures block execution; optional
  failures remain reported skips.
- Web contracts expose assignments and stable revisions, and the share drawer
  sends scope assignments without expanding teams into agent IDs.

The security review shaped digest/key validation, atomic object replacement,
restrictive permissions, bounded publication/export data, target-ownership
checks, command-scoped blob authorization, and required-skill fail-closed
behavior.
