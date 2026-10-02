/** The employee-handle grammar, mirroring `normalize_employee_handle` in
    `backend/relay/api/helpers.py`. The handle is rendered as `@alice` and
    threaded through node paths and credential filenames, so two spellings must
    never look like one identity.

    Normalization runs as the admin types, so the drawer's `@handle` preview
    shows the handle that will actually be created rather than the raw keystrokes.
    The backend stays the authority and applies the same rules regardless. */
const EMPLOYEE_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

/** Strip the decorative `@`, surrounding space, and case differences. */
export function normalizeEmployeeHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** True when the normalized handle is one the backend will accept. */
export function isValidEmployeeHandle(handle: string): boolean {
  return EMPLOYEE_HANDLE_PATTERN.test(handle);
}

/** The @handle to show for an employee.

    `id` is a UUID under the database auth store, which is exactly the string
    the handle grammar exists to keep off the screen — so it is never the
    fallback. A record from an older backend that carries no handle falls back
    to its display name, slugified. */
export function employeeHandleOf(
  employee: { handle?: string; id: string; displayName?: string } | null | undefined,
): string {
  if (!employee) return "";
  if (employee.handle) return employee.handle;
  if (!isUuid(employee.id)) return employee.id;
  const slug = normalizeEmployeeHandle(employee.displayName ?? "").replace(/[^a-z0-9._-]+/g, "-");
  return slug || employee.id.slice(0, 8);
}

/** The @handle for an id carried on a record that has no employee attached —
    a computer's `employeeId`, say. Falls back to the id when the employee is
    not in the roster (a stale assignment). */
export function handleForEmployeeId(
  employees: ReadonlyArray<{ handle?: string; id: string; displayName?: string }>,
  employeeId: string | null | undefined,
): string {
  if (!employeeId) return "";
  const employee = employees.find((candidate) => candidate.id === employeeId);
  return employee ? employeeHandleOf(employee) : employeeId;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
