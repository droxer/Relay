import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import {
  buildEmployeeSummaries,
  isOverLocalComputerLimit,
  localComputerUsageLabel,
} from "../src/lib/adminHelpers.js";
import { parseLimitInput } from "../src/lib/computerLimits.js";
import type { ControlPanelDaemonNodeRecord, EmployeeRecord } from "../src/types.js";

function localNode(id: string, employeeId: string): ControlPanelDaemonNodeRecord {
  return {
    id,
    employeeId,
    status: "ready",
    online: true,
    nodeLocation: "employee-device",
    sandboxMode: "none",
    queuedCommandCount: 0,
    activeRuns: [],
  } as unknown as ControlPanelDaemonNodeRecord;
}

function managedNode(id: string, employeeId: string): ControlPanelDaemonNodeRecord {
  return {
    id,
    employeeId,
    status: "ready",
    online: true,
    nodeLocation: "managed",
    sandboxMode: "boxlite",
    queuedCommandCount: 0,
    activeRuns: [],
  } as unknown as ControlPanelDaemonNodeRecord;
}

function employee(input: Partial<EmployeeRecord> & { id: string }): EmployeeRecord {
  return { displayName: input.id, ...input };
}

describe("parseLimitInput", () => {
  it("reads an empty field as clearing the override, not as zero", () => {
    assert.equal(parseLimitInput(""), null);
    assert.equal(parseLimitInput("   "), null);
    // Zero is a real limit that blocks every enrollment, so it must survive.
    assert.equal(parseLimitInput("0"), 0);
  });

  it("rejects fractions, text, and values outside the range", () => {
    assert.equal(parseLimitInput("1.5"), undefined);
    assert.equal(parseLimitInput("many"), undefined);
    assert.equal(parseLimitInput("-1"), undefined);
    assert.equal(parseLimitInput("51"), undefined);
    assert.equal(parseLimitInput("50"), 50);
  });
});

describe("employee summary computer limits", () => {
  it("counts only personal computers against the limit", () => {
    const [summary] = buildEmployeeSummaries(
      [employee({ id: "alice", effectiveMaxLocalComputers: 3 })],
      [localNode("n1", "alice"), managedNode("n2", "alice")],
    );
    assert.equal(summary.localComputerCount, 1);
    assert.equal(summary.nodeCount, 2);
    assert.equal(localComputerUsageLabel(summary), "1/3");
    assert.equal(isOverLocalComputerLimit(summary), false);
  });

  it("carries the override through and flags an employee over a lowered limit", () => {
    const [summary] = buildEmployeeSummaries(
      [employee({ id: "alice", maxLocalComputers: 1, effectiveMaxLocalComputers: 1 })],
      [localNode("n1", "alice"), localNode("n2", "alice")],
    );
    assert.equal(summary.maxLocalComputers, 1);
    assert.equal(localComputerUsageLabel(summary), "2/1");
    assert.equal(isOverLocalComputerLimit(summary), true);
  });

  it("shows a bare count and never flags when the server sent no limit", () => {
    const [summary] = buildEmployeeSummaries(
      [employee({ id: "alice" })],
      [localNode("n1", "alice")],
    );
    assert.equal(summary.maxLocalComputers, null);
    assert.equal(localComputerUsageLabel(summary), "1");
    assert.equal(isOverLocalComputerLimit(summary), false);
  });
});

describe("settings copy", () => {
  it("ships every key the settings and employee-limit surfaces render", async () => {
    const locale = JSON.parse(
      await readFile(resolve("web/src/i18n/locales/en/translation.json"), "utf8"),
    );
    const v2 = locale.admin.v2;
    for (const key of [
      "nav_organization",
      "title_organization",
      "settings_computers_title",
      "settings_limit_label",
      "settings_limit_hint",
      "settings_limit_invalid",
      "settings_save",
      "settings_saved",
      "settings_reset",
      "emp_limit_label",
      "emp_limit_hint",
      "emp_limit_placeholder",
      "emp_limit_use_default",
      "emp_limit_over",
      "col_local_limit",
      "edit_employee_title",
      "edit_employee_action",
    ]) {
      assert.equal(typeof v2[key], "string", `missing admin.v2.${key}`);
    }
  });
});
