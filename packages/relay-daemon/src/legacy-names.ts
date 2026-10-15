// Relay called the person who owns a computer an "employee" until the user
// rename. Installed services, saved enrollments, and shell environments written
// before it still carry the old names; read them here so the rest of the
// daemon only sees `userId`.

/** Flags that name the computer's user; the second is the pre-rename spelling. */
export const USER_ID_FLAGS = ["--user-id", "--employee-id"] as const;

export function userIdFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RELAY_USER_ID ?? env.RELAY_EMPLOYEE_ID;
}

export function isUserIdFlag(arg: string): boolean {
  return (USER_ID_FLAGS as readonly string[]).includes(arg);
}

/** `userId` from a saved record or backend response, else its legacy `employeeId`. */
export function legacyUserId(record: { userId?: unknown; employeeId?: unknown }): string | undefined {
  const value = record.userId ?? record.employeeId;
  return typeof value === "string" && value ? value : undefined;
}
