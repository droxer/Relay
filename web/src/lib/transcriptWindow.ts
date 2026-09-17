/* How much of a transcript is mounted.

   Every turn used to mount on open — a 300-turn thread was 25k DOM nodes and a
   single 1.5s main-thread task before the reader saw its newest message, which
   is the only part they came for. The window opens on the newest page and
   grows a page at a time as the reader scrolls up. */

export const TRANSCRIPT_PAGE_SIZE = 40;

/** Index of the first mounted message when `visible` messages are mounted. */
export function transcriptWindowStart(total: number, visible: number): number {
  return Math.max(0, total - visible);
}

/** The window after the reader reaches the top of what is mounted. */
export function nextTranscriptWindow(visible: number, total: number): number {
  return Math.min(total, visible + TRANSCRIPT_PAGE_SIZE);
}

/** The mounted count after the transcript changes length.
 *
 *  Appended messages extend the window rather than pushing a turn out of the
 *  top, which would shift what the reader is looking at. A jump of more than a
 *  page is a thread hydrating from its summary, so it opens on the newest page
 *  like any first load. */
export function transcriptVisibleAfter(previousTotal: number, visible: number, total: number): number {
  const grew = total - previousTotal;
  if (grew > TRANSCRIPT_PAGE_SIZE) return Math.min(total, TRANSCRIPT_PAGE_SIZE);
  return Math.min(total, visible + Math.max(0, grew));
}
