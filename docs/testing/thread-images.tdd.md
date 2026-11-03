# Thread image attachment verification

Source: journeys derived from the Thread image/R2 implementation request.

## Behavior and ownership

A User can select or paste up to four images, preview/remove them, and send
images in a new or existing Thread. A failed send keeps the uploaded references
and retry identity. Postgres stores metadata and Thread bindings; the existing
blob store holds bytes (private R2 when configured, database fallback otherwise).

The upload/download routes live in `api/threads/attachments.py`; storage is a
session-store concern with a dedicated `thread_attachments` table. Collaboration
admission binds attachments and preserves the most recent visual context.
`run.start` carries references; the daemon downloads and verifies bytes inside
the mounted workspace. Codex uses native image input, including its app-server
adapter. Claude receives structured image blocks on stdin. Other runtimes and
Computers missing `image-attachments` are refused explicitly.

## RED / GREEN evidence

- Initial `pytest backend/tests/api/test_thread_attachments.py -q`: **3 failed**
  because upload routes did not exist (404).
- Initial built `node --test dist/packages/relay-core/tests/image-attachments.test.js`:
  **2 failed** because commands did not supply image inputs.
- API/storage tests now cover private uploads, MIME signatures and byte limits,
  ownership and Thread binding, malformed ids, command-scoped downloads,
  revoked command access, initial messages, retry fingerprints, visual continuity,
  old clients, database/R2 round trips, integrity failures, deletion, abandoned
  uploads, atomic batch binding, upload compensation, and migration upgrade/downgrade.
- The new native-command test checks that the runtime receives its private input
  file on stdin. A fake Claude process verifies actual base64 image blocks,
  shell quoting, and retrying the same invocation after a resume failure.
- Daemon tests check guest/local path mapping, bounded downloads, SHA-256,
  temporary-file cleanup, and refusal of unsafe directories and invalid manifests.
- Browser checks with mocked API responses exercised selection, persisted previews,
  a rejected send followed by a successful retry without re-uploading, matching
  retry keys, and desktop/375px layouts. The corrected mobile composer and send
  control fit within the viewport; no document overflow was observed.

## Validation

| Check | Result |
| --- | --- |
| Attachment API/storage suite | 16 passed |
| Attachment API/storage coverage | 95% across the three new runtime modules |
| Backend type check (`cd backend && uv run --extra dev mypy`) | Zero errors |
| Backend lint (`uv run --project backend --extra dev ruff check backend`) | Passed |
| Layering, module-size, route-auth, client-capability parity checks | Passed |
| Focused attachment + Codex app-server adapter tests | 23 passed |
| Final native transport / image-input tests | 25 passed |
| Final daemon integration suite | 145 passed |
| Full React interaction suite | 763 passed; final composer/dispatch rerun: 12 passed |
| TypeScript compile and web type check | Passed |
| Production export (`npm run build -w web -- --webpack`) | Passed |
| Computer installer bundle | Rebuilt with image support |
| Impeccable detector on changed UI | No findings |
| `git diff --check` | Passed |

The full Python run completed with **3,376 passed, 32 skipped, 4 failed**. Three
failures were sandbox denial of `/dev/tty`; they passed when rerun with terminal
access. The fourth was a compatibility test deriving its simulated old payload
from the new dataclass; it now excludes the new optional attachment field and
also checks that adding an image changes the fingerprint. All four failed cases
passed in a focused rerun (54 tests). Later attachment/migration tests also pass.

The full built TypeScript suite completed with **2,890 passed, 1 failed**. The
remaining failure is the existing weight-ladder check against
`settings-page.css:43` (`font-weight: 600`), unchanged from HEAD. No settings styles
were modified. Socket-based tests passed when run with local-server access.
Turbopack's changed-CSS rebuild hit a sandbox worker-port restriction; webpack
successfully produced the final static export.

## Rollout and limits

Apply migration `20261103_0107` before starting the backend. Hosted installs use
the existing `RELAY_BLOB_STORE=r2` configuration; update Computer clients to the
rebuilt bundle. The selected Codex/Claude model must support image input.
No deployment, credentials, or third-party resources were changed.

Tests use FakeS3, SQLite, fake runtime processes, and browser API fixtures. Live
R2 credentials, a real multimodal model call, Windows, a running BoxLite guest,
and PostgreSQL schema drift were not exercised. Abandoned uploads are pruned
on subsequent uploads after 24 hours (100 per request). Object deletion is best
effort; interrupted daemon processes may also leave temporary workspace files.
