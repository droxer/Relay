/** The new-thread landing greets the person by name and time of day. */
export type GreetingPeriod = "late" | "morning" | "afternoon" | "evening";

export function greetingPeriod(hour: number): GreetingPeriod {
  if (hour < 5) return "late";
  if (hour < 12) return "morning";
  if (hour < 18) return "afternoon";
  return "evening";
}

/** First word of the display name, else the username — "Fei", not "Fei He". */
export function greetingName(user: { displayName?: string; username: string }): string {
  const first = user.displayName?.trim().split(/\s+/)[0];
  return first || user.username.trim();
}
