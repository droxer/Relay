import { render, fireEvent } from "@testing-library/react";
import { createInstance } from "i18next";
import { expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import cn from "../src/i18n/locales/zh-CN/translation.json";
import tw from "../src/i18n/locales/zh-TW/translation.json";
import { ComputerCard } from "../src/components/computer/ComputerCard";
import { NodeRuntimeMarks } from "../src/components/admin/NodeRuntimeMarks";
import { ManageAgentRow } from "../src/components/admin/ManageAgentRow";
import type { ControlPanelDaemonNodeRecord } from "../src/types";

const raw = "Codex check failed (exit code 1).\nOriginal CLI output: /usr/bin/codex — user@example.com";
const resources = { en: { translation: en }, "zh-CN": { translation: cn }, "zh-TW": { translation: tw } };
const makeNode = (status: string) => ({
  id: "computer", displayName: "My computer", status: "ready", online: true,
  nodeLocation: "user-device", sandboxMode: "none", agents: { codex: status },
  agentDetails: { codex: { detail: raw, version: "1.2.3" } },
}) as unknown as ControlPanelDaemonNodeRecord;

it.each(["en", "zh-CN", "zh-TW"])("localizes runtime hover text in %s and preserves original diagnostics separately", async (lng) => {
  const i18n = createInstance();
  await i18n.init({ lng, fallbackLng: false, resources });
  for (const status of ["unavailable", "unresponsive", "failed", "unknown", "ready"]) {
    const node = makeNode(status);
    const t = i18n.t.bind(i18n);
    const card = render(<ComputerCard node={node} t={t} onRename={vi.fn()} onManageExecutors={vi.fn()} onShowToken={vi.fn()} onDisconnect={vi.fn()} />);
    const marks = render(<NodeRuntimeMarks node={node} t={t} />);
    for (const title of [card.container.querySelector(".computer-runtime-row")?.getAttribute("title"), marks.container.querySelector(".adm-runtime-readout")?.getAttribute("title")]) {
      expect(title).toBeTruthy();
      expect(title).not.toContain(raw);
      if (status !== "ready") {
        const explanation = t(`computer.runtime_detail_${status}`);
        expect(explanation).not.toBe(`computer.runtime_detail_${status}`);
        expect(title).toContain(explanation);
      }
    }
    const row = render(<ManageAgentRow node={node} agent="codex" savedEnabled enabled saving={false} onToggle={vi.fn()} t={t} />);
    if (status === "ready") expect(row.container.querySelector("details")).toBeNull();
    else {
      const disclosure = row.container.querySelector("details")!;
      expect(disclosure).not.toBeNull();
      fireEvent.click(disclosure.querySelector("summary")!);
      expect(disclosure.open).toBe(true);
      expect(disclosure.querySelector("pre")?.textContent).toBe(raw);
    }
    card.unmount(); marks.unmount(); row.unmount();
  }
});

it("updates native tooltip text when the selected language changes and suppresses disabled diagnostics", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", fallbackLng: false, resources });
  const node = makeNode("unavailable");
  const view = render(<NodeRuntimeMarks node={node} t={i18n.getFixedT("en")} />);
  const before = view.container.querySelector(".adm-runtime-readout")!.getAttribute("title");
  await i18n.changeLanguage("zh-CN");
  view.rerender(<NodeRuntimeMarks node={node} t={i18n.getFixedT("zh-CN")} />);
  const after = view.container.querySelector(".adm-runtime-readout")!.getAttribute("title");
  expect(after).not.toBe(before);
  expect(after).toContain(i18n.t("computer.runtime_detail_unavailable"));
  view.rerender(<NodeRuntimeMarks node={{ ...node, disabledAgents: ["codex"] }} t={i18n.getFixedT("zh-CN")} />);
  expect(view.container.querySelector(".adm-runtime-readout")!.getAttribute("title")).not.toContain(i18n.t("computer.runtime_detail_unavailable"));
});

it("keeps offline state and disabled diagnostics consistent without a daemon detail", async () => {
  const { runtimeStateLabel, runtimeNotReadyDetail } = await import("../src/components/computer/runtimeStateLabel");
  const i18n = createInstance();
  await i18n.init({ lng: "zh-CN", fallbackLng: false, resources });
  const t = i18n.getFixedT("zh-CN");
  const missing = { ...makeNode("unknown"), agents: {}, agentDetails: undefined };
  expect(runtimeNotReadyDetail(missing, "codex", false, t)).toBe(t("computer.runtime_detail_unknown"));
  for (const status of ["ready", "unresponsive", "unknown"]) {
    const offline = { ...makeNode(status), online: false, stale: true };
    expect(runtimeStateLabel(offline, "codex", false, t)).toBe(t("nodes.presence_offline"));
  }
  expect(runtimeStateLabel(missing, "codex", true, t)).toBe(t("admin.v2.agent_disabled"));
  expect(runtimeNotReadyDetail(missing, "codex", true, t)).toBeUndefined();
  const row = render(<ManageAgentRow node={makeNode("failed")} agent="codex" savedEnabled={false} enabled={false} saving={false} onToggle={vi.fn()} t={t} />);
  expect(row.container.querySelector("details")).toBeNull();
});
