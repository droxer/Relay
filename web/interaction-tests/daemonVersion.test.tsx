import { render, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { it, expect, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import cn from "../src/i18n/locales/zh-CN/translation.json";
import tw from "../src/i18n/locales/zh-TW/translation.json";
import { NodeCard } from "../src/components/admin/NodeCard";
import { NodeIdentityCell } from "../src/components/admin/NodeRow";
import { ComputerCard } from "../src/components/computer/ComputerCard";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { ControlPanelDaemonNodeRecord } from "../src/types";

it.each([
  ["en", en, "Not reported"],
  ["zh-CN", cn, "未上报"],
  ["zh-TW", tw, "未上報"],
])("shows each Computer's daemon version and missing state in %s", async (lng, translation, missing) => {
  const i18n = createInstance();
  await i18n.init({ lng, resources: { [lng]: { translation } } });
  const t = i18n.getFixedT(lng);
  const node: ControlPanelDaemonNodeRecord = {
    id: "computer", status: "ready", agents: {}, queuedCommandCount: 0,
    activeRuns: [], online: false, stale: true, createdAt: "", updatedAt: "",
    clientVersion: "1.2.3-rc.1+build.42",
  };
  const views = (record: ControlPanelDaemonNodeRecord) => <DialogProvider>
    <NodeCard node={record} t={t} onRename={vi.fn()} onManageExecutors={vi.fn()} />
    <NodeIdentityCell node={record} t={t} />
    <ComputerCard node={record} t={t} onRename={vi.fn()} onManageExecutors={vi.fn()} onShowToken={vi.fn()} onDisconnect={vi.fn()} />
  </DialogProvider>;
  const view = render(views(node));
  expect(within(view.container).getAllByText("Relay Daemon 1.2.3-rc.1+build.42")).toHaveLength(3);
  view.rerender(views({ ...node, clientVersion: undefined }));
  expect(within(view.container).getAllByText(`Relay Daemon ${missing}`)).toHaveLength(3);
});
