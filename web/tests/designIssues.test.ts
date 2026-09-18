import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { resolve } from "node:path";

import { activityChartMetrics } from "../src/lib/activityChart.ts";

const readWeb = (path: string) => readFileSync(resolve("web", path), "utf8");

describe("reviewed design regressions", () => {
  it("keeps record detail tabs visible on mobile routes", () => {
    const responsive = readWeb("src/styles/responsive.css");

    // The shared hiding rule must have lower specificity than route overrides.
    // Merely finding a later `position: static` does not prove it wins.
    assert.match(responsive, /\.messenger-shell:where\(\[data-route\]:not\(\[data-route="main"\]\)\) \.page-header-lead\s*\{/);
    assert.doesNotMatch(responsive, /\.messenger-shell\[data-route\]:not\(\[data-route="main"\]\) \.page-header-lead\s*\{/);

    for (const route of ["agents", "teams", "projects"]) {
      assert.match(
        responsive,
        new RegExp(`\\.messenger-shell\\[data-route="${route}"\\] \\.page-header-lead[\\s\\S]*?position:\\s*static`),
        `${route} must restore the header lead that contains its tabs`,
      );
    }
  });

  // Agent Back/discard behavior is exercised in e2e/frontendRecovery.spec.ts.

  it("uses compact pagination on narrow screens, including its page readout", () => {
    const pager = readWeb("src/components/ui/Pagination.tsx");
    assert.match(pager, /useMediaQuery\("\(max-width: 820px\)"\)/);
    assert.match(pager, /const isCompact = compact \|\| narrow;/);
    assert.match(pager, /const numbers = isCompact \? \[\] : pageNumbers/);
    assert.match(pager, /\{isCompact[\s\S]*?pagination_range_compact/);
  });

  it("does not display a failed token total as a measured value", () => {
    const dashboard = readWeb("src/components/admin/dashboard/DashboardView.tsx");
    assert.match(dashboard, /value=\{tokens\.isError \? dash : formatCompact\(tokens\.total, i18n\.language\)\}/);
    assert.match(dashboard, /hint=\{tokens\.isError \? t\("workspace.load_failed"\)/);
  });

  it("keeps project member actions discoverable without hover", () => {
    const styles = readWeb("src/styles/project-page.css");
    assert.match(
      styles,
      /@media \(hover: none\)[\s\S]*?\.project-member-tile-edit\s*\{[^}]*opacity:\s*1/s,
    );
  });

  it("does not treat failed artifact downloads as copied content", () => {
    const header = readWeb("src/components/artifact/ArtifactPreviewHeader.tsx");
    assert.match(header, /const response = await fetch\(rawHref\);\s*if \(!response\.ok\) throw new Error/s);
  });

  it("preserves a visible unavailable state for failed dashboard data", () => {
    const dashboard = readWeb("src/components/admin/dashboard/DashboardView.tsx");
    const sessionHook = readWeb("src/hooks/useDashboardSessions.ts");
    const tokenHook = readWeb("src/hooks/useTokenUsage.ts");

    assert.match(dashboard, /const sessionsReady = !sessionsQuery\.isLoading && !sessionsQuery\.error;/);
    assert.match(dashboard, /<TopEmployees[\s\S]*?error=\{sessionsQuery\.error\}/);
    assert.match(sessionHook, /isError: boolean/);
    assert.match(tokenHook, /isError:/);
  });

  it("lets agent and team routes distinguish failed loads from empty results", () => {
    const agents = readWeb("src/hooks/useEmployeeAgents.ts");
    const teams = readWeb("src/hooks/useTeams.ts");

    assert.match(agents, /error: string \| null/);
    assert.match(teams, /error: string \| null/);
  });

  it("keeps chart scale padding separate from the reported data peak", () => {
    assert.deepEqual(activityChartMetrics([]), { dataPeak: 0, scaleMax: 4 });
    assert.deepEqual(
      activityChartMetrics([{ date: "2026-08-29", count: 2, completed: 0, failed: 0 }]),
      { dataPeak: 2, scaleMax: 4 },
    );
    assert.deepEqual(
      activityChartMetrics([{ date: "2026-08-29", count: 7, completed: 0, failed: 0 }]),
      { dataPeak: 7, scaleMax: 7 },
    );
  });

  it("limits the mobile tab bar to primary destinations and puts secondary routes in More", () => {
    const nav = readWeb("src/components/SideNav.tsx");
    const responsive = readWeb("src/styles/responsive.css");

    assert.match(responsive, /\.sidenav-secondary-item\s*\{[^}]*display:\s*none\s*!important/s);

    // The secondary destinations live in the More overflow. They used to be
    // hand-repeated <a className="sidenav-more-item"> blocks; they are
    // one MORE_ROUTES table rendered through DropdownMenuLinkItem now, so the
    // check reads the table rather than the markup it expands to.
    const table = nav.match(/const MORE_ROUTES[\s\S]*?\n\];/)?.[0];
    assert.ok(table, "SideNav must declare a MORE_ROUTES table");
    for (const route of ["routine", "teams", "computer", "admin"]) {
      assert.match(table, new RegExp(`route: "${route}"`));
    }
    assert.doesNotMatch(nav, /data-nav="channels"|route: "channels"/);
    // Still real links, and still the app's own client-side navigation.
    assert.match(nav, /DropdownMenuLinkItem[\s\S]*?href=\{hrefForRoute\(target\)\}/);
    assert.match(nav, /onClick=\{\(event: MouseEvent<HTMLAnchorElement>\) => handleRouteClick\(event, target\)\}/);
    assert.doesNotMatch(nav, /channelsHint|coming_soon_short/);
  });

  it("uses a one-pane list/detail flow for agents and teams on mobile", () => {
    const agents = readWeb("src/components/AgentsPage.tsx");
    const teams = readWeb("src/components/TeamsPage.tsx");
    const agentStyles = readWeb("src/styles/agents.css");
    const teamStyles = readWeb("src/styles/teams.css");

    assert.match(agents, /data-view=\{detailAgent \? "detail" : "list"\}/);
    assert.match(agents, /className="agents-mobile-back"/);
    assert.match(agentStyles, /\.agents-page\[data-view="list"\]\s+\.agents-detail\s*\{[^}]*display:\s*none/s);
    assert.match(agentStyles, /\.agents-page\[data-view="detail"\]\s+\.agents-roster\s*\{[^}]*display:\s*none/s);

    assert.match(teams, /data-view=\{selectedTeam \? "detail" : "list"\}/);
    assert.match(teams, /className="teams-mobile-back"/);
    assert.match(teamStyles, /\.teams-page\[data-view="list"\]\s+\.teams-detail\s*\{[^}]*display:\s*none/s);
    assert.match(teamStyles, /\.teams-page\[data-view="detail"\]\s+\.teams-roster\s*\{[^}]*display:\s*none/s);
  });

  it("keeps empty states free of a decorative layer", () => {
    const emptyState = readWeb("src/components/RelayEmptyState.tsx");
    const board = readWeb("src/components/BoardEmpty.tsx");
    const styles = readWeb("src/styles/empty-state.css");

    // No plate frame, crop ticks, corner doodle, watermark glyph, or orbit
    // ring: an empty state composes from type, spacing, and one mark tile.
    for (const source of [emptyState, board]) {
      assert.doesNotMatch(source, /marginalia|RelayDoodle|relay-plate|relay-bleed-mark/);
    }
    assert.doesNotMatch(styles, /relay-bleed-mark|relay-plate|marginalia|--et-tick/);
    assert.doesNotMatch(styles, /\.relay-empty(-avatar)?::(before|after)/);
    // The hero renders settled like every other empty state.
    assert.doesNotMatch(styles, /animation:\s*rise/);
  });

  it("associates reviewed select triggers with their visible labels", () => {
    const taskDrawer = readWeb("src/components/task-board/TaskDrawer.tsx");
    const teamDrawer = readWeb("src/components/admin/TeamDrawer.tsx");
    const employeeDrawer = readWeb("src/components/admin/AddEmployeeDrawer.tsx");

    assert.match(taskDrawer, /labelId=\{priorityLabelId\}[\s\S]*?aria-labelledby=\{priorityLabelId\}/);
    assert.match(teamDrawer, /labelId=\{leadLabelId\}[\s\S]*?aria-labelledby=\{leadLabelId\}/);
    assert.match(employeeDrawer, /labelId=\{nodeLabelId\}[\s\S]*?aria-labelledby=\{nodeLabelId\}/);
  });

  it("reserves fallback space for markdown images", () => {
    const markdownStyles = readWeb("src/styles/markdown.css");
    assert.match(markdownStyles, /\.md-body img\s*\{[^}]*aspect-ratio:\s*auto 16 \/ 9/s);
  });

  it("insets a rendered file body, and never via the transcript's prose class", () => {
    /* Every surface that shows a whole file renders <Markdown variant="document">,
       which emits .doc-prose — .agent-prose is the TRANSCRIPT's class and cannot
       appear inside an artifact body. Two sheets in a row insets their document
       by naming .agent-prose there, so the rule matched nothing and the file sat
       flush against the panel edge with its text clipped at the border. Both the
       gutter and the class it hangs on are asserted, because the gutter passing
       through a dead selector is exactly what this looked like. */
    const artifact = readWeb("src/styles/artifact.css");
    const workspace = readWeb("src/styles/workspace-files.css");
    // Selectors only: both sheets NAME .agent-prose in the comment explaining
    // why it must not be used here, and a comment is not a rule.
    const rules = (sheet: string) => sheet.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [name, sheet] of [["artifact.css", artifact], ["workspace-files.css", workspace]] as const) {
      assert.ok(
        !/\.(?:artifact-viewer-body|workspace-preview-viewport)[^{;]*\.agent-prose[^{;]*\{/.test(rules(sheet)),
        `${name} insets a file body through .agent-prose, which never renders there`,
      );
    }
    assert.match(artifact, /\.artifact-viewer-body > \.doc-prose\s*\{[^}]*padding:\s*var\(--doc-inset-block\) var\(--doc-inset-inline\)/s);
    // Prose and source share the inset: differing values jolt the text sideways
    // on every Preview/Source toggle of one file.
    assert.match(artifact, /\.artifact-viewer-body > \.code-view\s*\{[^}]*margin:\s*var\(--doc-inset-block\) var\(--doc-inset-inline\)/s);
    // A panel a few hundred pixels wide cannot spend the page's 32px a side.
    assert.match(readWeb("src/styles/thread-space.css"), /\.thread-space-panel\s*\{[^}]*--doc-inset-inline:/s);
  });

  it("keeps one dismissal in the panel header and backs out from the file's row", () => {
    /* The panel header used to swap its title for a `← Files` button whenever a
       file was open, seating a back control and the close control side by side
       in one row — two controls that both read as "get me out of here", and a
       panel whose identity row disappeared the moment you used it. The header
       now always states the panel's name and carries only the close; going back
       is the file header's job, one row down, where the project Files tab had
       been putting it all along. */
    const panel = readWeb("src/components/space/ThreadSpacePanel.tsx");
    assert.match(panel, /<h2 className="thread-space-title">\{panelName\}<\/h2>/);
    assert.ok(
      !/thread-space-header[\s\S]{0,400}onSelectArtifact\(null\)/.test(panel),
      "the panel header backs out of a file again, beside its close button",
    );
    assert.match(panel, /<ArtifactPreviewHeader[\s\S]{0,300}onBack=\{\(\) => onSelectArtifact\(null\)\}/);

    // One back control, one spelling of it, on every surface a file opens on.
    for (const surface of [
      "src/components/space/ThreadSpaceFiles.tsx",
      "src/components/task-board/TaskDrawerWorkspace.tsx",
      "src/components/artifact/ArtifactPreviewHeader.tsx",
    ]) {
      assert.match(readWeb(surface), /<FilePaneBack/, `${surface} rolls its own back control`);
    }
  });

  it("gives a workspace file one set of controls, wherever it opens", () => {
    /* The switch used to sit in the panel header on one surface and in the body
       on another, spelled "Preview/Source" here and "Rendered/Source" there,
       with a download on only one of the three. All three now mount the same
       component in the file's own header row. */
    const surfaces = [
      "src/components/ProjectWorkspaceFiles.tsx",
      "src/components/space/ThreadSpaceFiles.tsx",
      "src/components/task-board/TaskDrawerWorkspace.tsx",
    ];
    for (const surface of surfaces) {
      assert.match(readWeb(surface), /<WorkspaceFileActions/, `${surface} builds its own file controls`);
    }
    // The preview is controlled: a header cannot read state its sibling holds.
    assert.ok(
      !/ToggleGroup/.test(readWeb("src/components/workspace/WorkspaceFilePreview.tsx")),
      "the preview body renders its own view switch again",
    );
  });
});
