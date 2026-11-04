/** Limits mirror backend/core/task_capacity.py. Empty restores the default. */
export const DEFAULT_TASK_CAPACITY = 5;
export const MAX_TASK_CAPACITY = 100;
export function parseTaskCapacity(value: string): number | null | undefined {
  const text = value.trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) return undefined;
  const number = Number(text);
  return Number.isInteger(number) && number >= 1 && number <= MAX_TASK_CAPACITY ? number : undefined;
}
