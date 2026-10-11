import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

describe("Admin page refresh stability", () => {
  it("keeps background polling from flashing page chrome", async () => {
    const adminPageSource = await readFile(resolve("web/src/components/AdminPage.tsx"), "utf8");
    const nodesSource = await readFile(resolve("web/src/hooks/useAdminNodes.ts"), "utf8");
    const relayDataSource = await readFile(resolve("web/src/hooks/useRelayData.ts"), "utf8");

    assert.doesNotMatch(adminPageSource, /\bisFetching\b/);
    assert.doesNotMatch(nodesSource, /\bisFetching\b/);
    assert.doesNotMatch(relayDataSource, /\bisFetching\b/);
    // The admin console polls on its own (useAdminNodes), so it carries no
    // manual refresh button — the shared isRefreshing state drives the
    // backlog/routine headers only.
    assert.doesNotMatch(adminPageSource, /manualRefreshPending/);
    assert.doesNotMatch(adminPageSource, /useUrlSearchState/);
    assert.match(relayDataSource, /const \[manualRefreshPending, setManualRefreshPending\] = useState\(false\)/);
  });

  it("refreshes the visible node list after permanently deleting managed-node history", async () => {
    const adminPageSource = await readFile(resolve("web/src/components/AdminPage.tsx"), "utf8");

    const permanentDeleteHandler = adminPageSource.match(
      /async function handlePermanentlyDeleteManagedNode[\s\S]*?\n  }/,
    )?.[0] ?? "";

    assert.match(permanentDeleteHandler, /permanentlyDeleteManagedNode\(node\.id\)/);
    assert.match(
      permanentDeleteHandler,
      /Promise\.all\(\[managedNodesQuery\.refetch\(\), refetch\(\)\]\)/,
    );
  });

  it("evicts a deleted computer from the Computers cache immediately", async () => {
    const adminPageSource = await readFile(resolve("web/src/components/AdminPage.tsx"), "utf8");
    const deleteHandler = adminPageSource.match(
      /async function handleDeleteNode[\s\S]*?\n  }/,
    )?.[0] ?? "";

    assert.match(adminPageSource, /NODES_QUERY_KEY/);
    assert.match(deleteHandler, /cancelQueries\(\{ queryKey: NODES_QUERY_KEY, exact: true \}\)/);
    assert.match(deleteHandler, /setQueryData<DaemonNodeMonitorRecord\[\]>/);
    assert.match(deleteHandler, /withoutDeletedComputer/);
    assert.match(deleteHandler, /invalidateQueries\(\{ queryKey: NODES_QUERY_KEY, exact: true \}\)/);
  });
});
