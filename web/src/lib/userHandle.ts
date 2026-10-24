/** The user-handle grammar, mirroring `normalize_user_handle` in
    `backend/relay/api/helpers.py`. The handle is rendered as `@alice` and
    threaded through node paths and credential filenames, so two spellings must
    never look like one identity.

    Normalization runs as the admin types, so the drawer's `@handle` preview
    shows the handle that will actually be created rather than the raw keystrokes.
    The backend stays the authority and applies the same rules regardless. */
const USER_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Strip the decorative `@`, surrounding space, and case differences. */
export function normalizeUserHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** True when the normalized handle is one the backend will accept. */
export function isValidUserHandle(handle: string): boolean {
  return USER_HANDLE_PATTERN.test(handle);
}

/** The @handle to show for a user.

    `id` is a UUID under the database auth store, which is exactly the string
    the handle grammar exists to keep off the screen — so it is never the
    fallback. A record from an older backend that carries no handle falls back
    to its display name, slugified. */
export function userHandleOf(
  user: { handle?: string; id: string; displayName?: string } | null | undefined,
): string {
  if (!user) return "";
  if (user.handle) return user.handle;
  if (!isUuid(user.id)) return user.id;
  const slug = normalizeUserHandle(user.displayName ?? "").replace(/[^a-z0-9._-]+/g, "-");
  return slug || user.id.slice(0, 8);
}

/** The @handle for an id carried on a record that has no user attached —
    a computer's `userId`, say. Falls back to the id when the user is
    not in the roster (a stale assignment). */
export function handleForUserId(
  users: ReadonlyArray<{ handle?: string; id: string; displayName?: string }>,
  userId: string | null | undefined,
): string {
  if (!userId) return "";
  const user = users.find((candidate) => candidate.id === userId);
  return user ? userHandleOf(user) : userId;
}

/** True when a user's @handle only restates their display name — a user
    whose name was never set beyond the handle would otherwise read
    "alice @alice", one identity printed twice. */
export function handleRestatesName(displayName: string | undefined, handle: string): boolean {
  if (!displayName) return false;
  return normalizeUserHandle(displayName) === normalizeUserHandle(handle);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
