/**
 * The app has ONE phone breakpoint, and this is it.
 *
 * At 820px and below the shell goes to its mobile layout: every drawer and
 * dialog becomes a full-viewport sheet (mobile-overlays.css), the rail and
 * panels collapse (responsive.css), and the admin tables / transcript rows
 * stack (admin-v2-*.css, chat.css, agent-stream.css). Those last few used to
 * switch at 719/720px instead, which left a 100px band where drawers were
 * already full-screen sheets but the transcript and the tables were still in
 * desktop layout.
 *
 * CSS spells it `(max-width: 820px)` — its complement is `(min-width: 821px)`.
 * JS that needs the same threshold imports this constant; do not re-type the
 * string (`ThreadSpacePanel` had its own copy).
 *
 * The wider layout thresholds (1040/1100/1200px) are per-surface column
 * decisions, not this one — they are not phone/desktop and do not belong here.
 * The one exception is SPACE_OVERLAY_QUERY below, which is here for the same
 * reason this constant is: CSS and JS must agree on it or the panel lies.
 */
export const OVERLAY_TAKEOVER_QUERY = "(max-width: 820px)";

/**
 * Where the thread space panel stops being a column and becomes an overlay.
 *
 * Wider than the phone tier, because the panel needs more room than a drawer:
 * below 900px the shell can no longer seat the sidenav, the conversation, and
 * a 288px panel on their floors at once (see the tier ladder in
 * responsive.css), so the panel leaves the grid and covers the viewport.
 *
 * This is a query BOTH sides read. responsive.css makes the panel `fixed` at
 * this width; ThreadSpacePanel reads the same query to render a real modal
 * there instead of a plain `<aside>`. When the two disagreed, an 80px band
 * (821–900px) showed a full-viewport panel with no scrim, no focus trap, and
 * an Escape key that did nothing.
 */
export const SPACE_OVERLAY_QUERY = "(max-width: 900px)";
