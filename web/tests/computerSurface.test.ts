import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

const read = (path: string) => readFile(resolve(path), "utf8");

describe("My Computer route shell", () => {
  it("owns a scroll body, because the app shell clips its children", async () => {
    // Regression: the route shipped with no stylesheet. `.messenger-shell` is
    // `overflow: hidden`, so a roster taller than the viewport was clipped and
    // its last card could not be reached by any scroll gesture.
    const [page, styles] = await Promise.all([
      read("web/src/components/ComputerPage.tsx"),
      read("web/src/styles/computer.css"),
    ]);
    assert.match(page, /className="computer-page-body"/);
    assert.match(styles, /\.computer-page-body\s*\{[^}]*overflow-y:\s*auto;/s);
    assert.match(styles, /\.computer-page\s*\{[^}]*overflow:\s*hidden;/s);
    assert.match(styles, /\.computer-page\s*\{[^}]*min-height:\s*0;/s);
  });

  it("insets the roster to the page header's own gutter", async () => {
    // The cards sat flush against the sidenav hairline, outdented from the
    // title above them, because .adm-fleet-grid carries no padding and nothing
    // else supplied one. PageHeader's inline padding is `px-xl` (--sp-7).
    const styles = await read("web/src/styles/computer.css");
    assert.match(styles, /\.computer-page-body\s*\{[^}]*padding:[^;]*var\(--sp-7\)/s);
  });

  it("is registered in the shared mobile row map", async () => {
    // Every work route needs `grid-row: 2` under the mobile topbar. The
    // roster is a settings section now, so the settings page is what claims
    // the row and the roster fills its content column.
    const responsive = await read("web/src/styles/responsive.css");
    const block = responsive.match(/([^}]*)\{\s*grid-row: 2;/)?.[1] ?? "";
    assert.match(block, /\.settings-page/);
    const settings = await read("web/src/styles/settings-page.css");
    assert.match(settings, /\.settings-page \.sec-main > \.computer-page/);
  });

  it("has a client-route rewrite so a direct load does not 404", async () => {
    const config = await read("web/next.config.ts");
    assert.match(config, /"\/settings\/:path\*"/);
  });

  it("keeps the connect action reachable on mobile", async () => {
    // Regression: the route hid its whole .page-header under 820px to kill an
    // empty grey strip, which took "Connect this computer" with it. The empty
    // state has its own button, so the loss only appeared once you owned a
    // computer — exactly when you were adding a second one.
    const styles = await read("web/src/styles/computer.css");
    const mobile = styles.slice(styles.indexOf("@media (max-width: 820px)"));
    assert.doesNotMatch(
      mobile,
      /\.computer-page \.page-header\s*\{[^}]*display:\s*none/s,
      "hiding the header removes the only Connect button on mobile",
    );
  });
});

describe("My Computer record card", () => {
  it("uses its own record card, not the admin fleet tile", async () => {
    // NodeCard is a survey tile meant to be scanned 40-at-a-time; reusing it
    // here reduced the reader's own machine to a name, a truncated id, and
    // four unlabelled vendor glyphs.
    const page = await read("web/src/components/ComputerPage.tsx");
    assert.match(page, /<ComputerCard/);
    assert.doesNotMatch(page, /<NodeCard/);
    assert.doesNotMatch(page, /adm-fleet-grid/);
  });

  it("names every runtime and states its version and health", async () => {
    const card = await read("web/src/components/computer/ComputerCard.tsx");
    assert.match(card, /computer-runtime-name/);
    assert.match(card, /computer-runtime-state/);
    assert.match(card, /computer-runtime-version/);
    assert.match(card, /labelForExecutor\(agent\)/);
  });

  it("labels its actions instead of relying on bare icons", async () => {
    const card = await read("web/src/components/computer/ComputerCard.tsx");
    assert.match(card, /\{t\("thread\.rename"\)\}/);
    assert.match(card, /\{t\("admin\.v2\.manage_executors"\)\}/);
  });

  it("offers the counterpart to self-service enrollment", async () => {
    // Connecting a computer is self-service, so removing one must be too —
    // otherwise a mistyped workspace leaves a row only an admin can clear.
    const [card, page] = await Promise.all([
      read("web/src/components/computer/ComputerCard.tsx"),
      read("web/src/components/ComputerPage.tsx"),
    ]);
    assert.match(card, /\{t\("computer\.disconnect"\)\}/);
    assert.match(page, /disconnectComputer\(node\.id\)/);
    assert.match(page, /tone: "danger"/, "removal is confirmed destructively");
  });

  it("does not offer self-service disconnect for an admin-managed computer", async () => {
    // The owner-scoped DELETE endpoint deliberately rejects managed computers:
    // their lifecycle belongs to the admin-managed-node control plane. Showing
    // this action only leads through confirmation to the generic disconnect
    // error toast reported by the user.
    const card = await read("web/src/components/computer/ComputerCard.tsx");
    const actions = card.match(/<div className="computer-card-actions">([\s\S]*?)<\/div>/)?.[1] ?? "";
    assert.notEqual(actions.trim(), "", "the actions regex stopped matching — refresh it");
    assert.match(
      actions,
      /node\.managedNodeId\s*\?\s*null\s*:\s*\([\s\S]*?onDisconnect\(node\)/,
      "managed computers must not offer an action their owner-scoped API forbids",
    );
  });

  it("explains active work instead of blaming the connection", async () => {
    // The disconnect endpoint returns 409 while this computer owns active
    // agent work. That is an actionable server refusal, not a network error.
    const [page, ...localeSources] = await Promise.all([
      read("web/src/components/ComputerPage.tsx"),
      read("web/src/i18n/locales/en/translation.json"),
      read("web/src/i18n/locales/zh-CN/translation.json"),
      read("web/src/i18n/locales/zh-TW/translation.json"),
    ]);
    const disconnect = page.match(/async function handleDisconnectNode[\s\S]*?\n  }/)?.[0] ?? "";
    assert.notEqual(disconnect.trim(), "", "the disconnect-handler regex stopped matching — refresh it");
    assert.match(disconnect, /error instanceof RelayApiError && error\.status === 409/);
    assert.match(disconnect, /t\("errors\.disconnect_computer_active"\)/);
    for (const source of localeSources) {
      const locale = JSON.parse(source);
      assert.equal(typeof locale.errors.disconnect_computer_active, "string");
    }
  });

  it("lets the owner see the token again for reconnecting", async () => {
    // Enrollment shows the token once; the card carries a labelled Token
    // action that opens the reveal/reissue drawer against the owner-scoped
    // token subresource.
    const [card, page, drawer] = await Promise.all([
      read("web/src/components/computer/ComputerCard.tsx"),
      read("web/src/components/ComputerPage.tsx"),
      read("web/src/components/computer/ComputerTokenDrawer.tsx"),
    ]);
    assert.match(card, /\{t\("computer\.token_button"\)\}/);
    assert.match(page, /<ComputerTokenDrawer/);
    assert.match(drawer, /revealComputerToken\(node!\.id\)/);
    assert.match(drawer, /reissueComputerToken\(node!\.id\)/);
    // Reissue burns the current token, so it is confirmed destructively.
    assert.match(drawer, /tone: "danger"/);
  });

  it("connects a personal computer as direct-run, with no runtime to pick", async () => {
    // BoxLite is provisioned on admin hardware. Offering "Isolated" here let an
    // employee ask their own laptop for a sandbox it was never set up to boot,
    // and the enrollment would hand back a start command for that VM.
    const [drawer, api] = await Promise.all([
      read("web/src/components/computer/ConnectComputerDrawer.tsx"),
      read("web/src/api.ts"),
    ]);
    assert.doesNotMatch(drawer, /boxlite/);
    assert.doesNotMatch(drawer, /connect-computer-sandbox-mode/);
    const enrollment = api.match(/createLocalDeviceEnrollment\([\s\S]*?\n\}/)?.[0] ?? "";
    assert.notEqual(enrollment.trim(), "", "the enrollment-call regex stopped matching — refresh it");
    assert.match(enrollment, /sandboxMode: "none"/);
  });

  it("reports adoption from `reused`, not from whether a token came back", async () => {
    // Adopting a computer whose enrollment never finished reissues its token,
    // so token presence answers "is there a secret to show", never "was this
    // already connected". Reading the second off the first told someone
    // re-running a half-finished connect that they had just connected.
    const drawer = await read("web/src/components/computer/ConnectComputerDrawer.tsx");
    assert.match(drawer, /result\.reused \? t\("computer\.connect_success_existing"\)/);
    assert.match(drawer, /token \? t\("computer\.connect_token_once"\)/);
  });

  it("keeps poll-derived liveness out of optimistic overrides", async () => {
    // `online`, `stale`, `activeRuns`, and `queuedCommandCount` are derived per
    // read and never bump `updatedAt`, so a wholesale override pinned a
    // renamed computer to the liveness it had when the rename landed.
    const page = await read("web/src/components/ComputerPage.tsx");
    const overlay = page.match(/if \(!override \|\| override\.updatedAt < node\.updatedAt\) return node;([\s\S]*?)\n {6}\},/)?.[1] ?? "";
    assert.notEqual(overlay.trim(), "", "the override regex stopped matching — refresh it");
    for (const derived of ["online", "stale", "activeRuns", "queuedCommandCount"]) {
      assert.doesNotMatch(
        overlay,
        new RegExp(`override\\.${derived}`),
        `${derived} comes from the poll, never from the override`,
      );
    }
  });

  it("spends the --live accent only on work that is running right now", async () => {
    // Phosphor's single chromatic role means "an agent is working". An idle
    // computer must carry none of it, so the idle branch may not reach for a
    // live mark or the elapsed counter.
    const [card, styles] = await Promise.all([
      read("web/src/components/computer/ComputerCard.tsx"),
      read("web/src/styles/computer.css"),
    ]);
    const liveRules = [...styles.matchAll(/([.\w-]+)\s*\{[^}]*var\(--live\)[^}]*\}/g)].map((m) => m[1]);
    assert.deepEqual(
      liveRules.sort(),
      [".computer-run-elapsed", ".computer-run-mark"],
      "--live belongs to the running-run mark and its elapsed timer, nothing else",
    );
    const idleBranch = (card.match(/activeRuns\.length === 0 \?([\s\S]*?)\) : \(/)?.[1] ?? "")
      // Drop comments, or prose *about* the rule reads as a violation of it.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    assert.notEqual(idleBranch.trim(), "", "the idle branch regex stopped matching — refresh it");
    assert.doesNotMatch(idleBranch, /live/i, "the idle state must not carry the accent");
  });
});

describe("My Computer: connect CTA respects the local-computer limit", () => {
  it("counts only employee-device computers, not managed cloud capacity", async () => {
    const page = await read("web/src/components/ComputerPage.tsx");

    assert.match(page, /const computersUsed = countEmployeeDeviceComputers\(myNodes\)/);
    assert.doesNotMatch(page, /const computersUsed = myNodes\.length/);
  });

  it("gates the connect button on the resolved limit from the session user", async () => {
    // The backend refuses a new enrollment at the limit (409), but a button
    // that only fails after a drawer of form-filling reads as broken, not
    // limited — the CTA must say so before the round trip.
    const page = await read("web/src/components/ComputerPage.tsx");
    assert.match(page, /currentUser\.effectiveMaxLocalComputers/);
    assert.match(page, /disabled=\{atLimit\}/);
    assert.match(page, /t\("computer\.limit_reached"/);
  });

  it("shows live usage against the limit on the button itself", async () => {
    // The count comes from the roster on screen, not the /auth/me snapshot,
    // so a connect or disconnect this session moves it immediately.
    const page = await read("web/src/components/ComputerPage.tsx");
    assert.match(page, /\{computersUsed\}\/\{computerLimit\}/);
    assert.match(page, /const computersUsed = countEmployeeDeviceComputers\(myNodes\)/);
  });

  it("ships the limit copy and the session fields it depends on", async () => {
    const [localeRaw, types] = await Promise.all([
      read("web/src/i18n/locales/en/translation.json"),
      read("web/src/types.ts"),
    ]);
    const locale = JSON.parse(localeRaw);
    assert.equal(typeof locale.computer.limit_reached, "string");
    const currentUser = types.match(/export interface CurrentUser \{[\s\S]*?\n\}/)?.[0] ?? "";
    assert.notEqual(currentUser, "", "the CurrentUser regex stopped matching — refresh it");
    assert.match(currentUser, /effectiveMaxLocalComputers\?: number/);
    assert.match(currentUser, /localComputerCount\?: number/);
  });
});

describe("Admin console: adding a local computer", () => {
  const DRAWERS = [
    "web/src/components/admin/AddNodeDrawer.tsx",
    "web/src/components/admin/AssignNodeDrawer.tsx",
  ];

  it("creates an employee device as direct-run, matching self-service enrollment", async () => {
    // Regression: both drawers sent `sandboxMode: "boxlite"` alongside
    // `nodeLocation: "employee-device"`. The backend stores the mode verbatim,
    // so the admin was handed `--sandbox boxlite` with no
    // `--use-local-agent-home` and the daemon tried to boot a VM on someone's
    // laptop — while the drawer's own copy promised agents would "run directly
    // on this computer".
    for (const path of DRAWERS) {
      const source = await read(path);
      const call = source.match(/createControlPanelDaemonNode\(\{[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
      assert.notEqual(call.trim(), "", `${path}: the create-call regex stopped matching — refresh it`);
      assert.match(call, /nodeLocation: "employee-device"/, path);
      assert.match(call, /sandboxMode: "none"/, path);
      assert.doesNotMatch(call, /sandboxMode: "boxlite"/, path);
    }
  });

  it("pairs nodeLocation with sandboxMode in the type, so the drawers cannot drift again", async () => {
    // The two fields are not independent. Encoding that in the input type makes
    // the regression above a compile error rather than a start command the
    // employee's machine cannot execute.
    const types = await read("web/src/types.ts");
    const input = types.match(/export type CreateControlPanelDaemonNodeInput =[\s\S]*?\n\s*\}\);/)?.[0] ?? "";
    assert.notEqual(input.trim(), "", "the input-type regex stopped matching — refresh it");
    assert.match(input, /nodeLocation: "employee-device";[\s\S]*?sandboxMode: "none";/);
    assert.match(input, /nodeLocation\?: never;[\s\S]*?sandboxMode\?: "boxlite";/);
  });

  it("labels the workspace field with a key that resolves", async () => {
    // `workspace_label` has no root-level entry — it lives under `nav`, so
    // i18next echoed the key and the admin read the literal "workspace_label"
    // above the path input.
    const locale = JSON.parse(await read("web/src/i18n/locales/en/translation.json"));
    for (const path of DRAWERS) {
      const source = await read(path);
      assert.doesNotMatch(source, /t\("workspace_label"\)/, path);
      assert.match(source, /t\("nav\.workspace_label"\)/, path);
    }
    assert.equal(typeof locale.nav.workspace_label, "string");
    assert.equal(locale.workspace_label, undefined, "the key was never root-level");
  });
});
