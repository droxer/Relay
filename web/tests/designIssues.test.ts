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
    for (const route of ["routine", "teams", "computer", "channels", "admin"]) {
      assert.match(nav, new RegExp(`sidenav-more-item[^>]*[\\s\\S]*?href=\\{hrefForRoute\\(\\"${route}\\"\\)\\}`));
    }
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
});
