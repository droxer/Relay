/** A compact extract for Home; the thread keeps the complete prompt. */
export function homeItemSummary(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "";
  const heading = firstLine
    .replace(/^#{1,6}\s+/, "")
    .split(/\s+(?:#{1,6}\s|---(?:\s|$)|Trigger context\b)/, 1)[0]
    .replace(/\s+/g, " ")
    .trim();
  const characters = Array.from(heading);
  return characters.length > 100 ? `${characters.slice(0, 99).join("").trimEnd()}…` : heading;
}
