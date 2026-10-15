import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

async function source(path: string): Promise<string> {
  return readFile(resolve(path), "utf8");
}

describe("node card layout", () => {
  it("states kind and owner as one quiet line, not chips", async () => {
    const [card, row, meta] = await Promise.all([
      source("web/src/components/admin/NodeCard.tsx"),
      source("web/src/components/admin/NodeRow.tsx"),
      source("web/src/components/admin/NodeMeta.tsx"),
    ]);

    assert.match(card, /<NodeMeta node=\{node\} userName=\{userName\}/);
    for (const surface of [card, row]) {
      assert.doesNotMatch(surface, /NodeProfileBadges/, "fleet surfaces no longer render ownership chips");
      assert.doesNotMatch(surface, /<Badge\b/, "the owner is plain text, not a badge");
    }
    assert.match(meta, /admin\.v2\.node_ownership_\$\{ownership\}/);
  });

  it("shows one status readout per card", async () => {
    const card = await source("web/src/components/admin/NodeCard.tsx");
    // Either the lifecycle pill or presence — never both side by side.
    assert.match(card, /\{showStatusPill \? \([\s\S]*?<TonePill[\s\S]*?\) : \([\s\S]*?<NodePresence[\s\S]*?\)\}/);
  });

  it("keeps every computer action behind one overflow menu", async () => {
    const [card, row, actions, styles] = await Promise.all([
      source("web/src/components/admin/NodeCard.tsx"),
      source("web/src/components/admin/NodeRow.tsx"),
      source("web/src/components/admin/NodeActions.tsx"),
      source("web/src/styles/admin-v2-nodes.css"),
    ]);

    assert.match(card, /<NodeActions\b/);
    assert.match(row, /<NodeActions\b/);
    assert.match(actions, /<DropdownMenuTrigger/);
    for (const label of [
      "admin.copy_node_id",
      "thread.rename_computer",
      "admin.v2.reveal_credentials",
      "admin.v2.manage_executors",
      "admin.v2.delete_action",
    ]) {
      assert.ok(actions.includes(`t("${label}")`), `${label} must stay reachable from the menu`);
    }
    // Credentials are a local-computer action; a Relay-run computer has none.
    assert.match(actions, /canReveal = Boolean\(onReveal\) && !node\.managedNodeId/);
    assert.doesNotMatch(styles, /adm-node-action--/, "the fixed icon slots are gone with the icons");
  });
});
