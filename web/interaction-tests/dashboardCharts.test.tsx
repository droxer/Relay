import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NodeStatusCard } from "../src/components/admin/dashboard/NodeStatusCard";
import { StackedBarChart } from "../src/components/admin/dashboard/StackedBarChart";
import type { ControlPanelDaemonNodeRecord } from "../src/types";

const node = (id: string, status: string, online = true) =>
  ({ id, status, online, stale: !online, activeRuns: [], queuedCommandCount: 0, agents: {} }) as unknown as ControlPanelDaemonNodeRecord;

describe("StackedBarChart", () => {
  const series = [
    { key: "other", label: "Open" },
    { key: "failed", label: "Failed" },
    { key: "completed", label: "Completed" },
  ];
  const columns = [
    { key: "a", label: "Oct 1", values: { completed: 6, failed: 1, other: 1 } },
    { key: "b", label: "Oct 2", values: { completed: 3, failed: 0, other: 0 } },
  ];

  function renderChart() {
    return render(
      <StackedBarChart
        columns={columns}
        series={series}
        format={String}
        ariaLabel="Threads"
        totalLabel={(column, total) => `${column.label} · ${total}`}
      />,
    );
  }

  it("stacks one segment per nonzero series, base first", () => {
    const { container } = renderChart();
    const first = [...container.querySelectorAll("g")[0].querySelectorAll("rect")].map((rect) => rect.getAttribute("class"));
    expect(first).toEqual(["adm-series adm-series--other", "adm-series adm-series--failed", "adm-series adm-series--completed"]);
    expect(container.querySelectorAll("g")[1].querySelectorAll("rect")).toHaveLength(1);
  });

  it("labels the axis on whole-number gridlines", () => {
    const { container } = renderChart();
    const labels = [...container.querySelectorAll(".adm-chart-y span")].map((span) => span.textContent);
    expect(labels).toEqual(["0", "2", "4", "6", "8"]);
  });

  it("shows a day's breakdown on hover, top of the stack first", () => {
    const { container } = renderChart();
    expect(container.querySelector(".adm-chart-tip")).toBeNull();
    fireEvent.mouseEnter(container.querySelectorAll(".adm-chart-hit span")[0]);
    const tip = container.querySelector(".adm-chart-tip");
    expect(tip?.querySelector(".adm-chart-tip-title")?.textContent).toBe("Oct 1 · 8");
    expect([...tip!.querySelectorAll(".adm-chart-tip-row")].map((row) => row.textContent)).toEqual(["Completed6", "Failed1", "Open1"]);
    fireEvent.mouseLeave(container.querySelector(".adm-chart-plot")!);
    expect(container.querySelector(".adm-chart-tip")).toBeNull();
  });
});

describe("NodeStatusCard", () => {
  it("draws one ring arc per present state and counts available computers", () => {
    const { container } = render(
      <NodeStatusCard
        nodes={[node("1", "running"), node("2", "ready"), node("3", "ready"), node("4", "failed"), node("5", "ready", false)]}
        queued={0}
        onManageNodes={() => {}}
      />,
    );
    const arcs = [...container.querySelectorAll(".adm-dash-ring-arc")].map((arc) => arc.getAttribute("class"));
    expect(arcs).toEqual([
      "adm-dash-ring-arc tone-live",
      "adm-dash-ring-arc tone-good",
      "adm-dash-ring-arc tone-bad",
      "adm-dash-ring-arc tone-warn",
    ]);
    expect(container.querySelector(".adm-dash-ring-value")?.textContent).toBe("3/5");
  });

  it("keeps an idle fleet grey: no live tone without a running computer", () => {
    const { container } = render(<NodeStatusCard nodes={[node("1", "ready")]} queued={0} onManageNodes={() => {}} />);
    expect(container.querySelector(".tone-live")).toBeNull();
    expect(container.querySelector(".adm-dash-stat[data-empty]")).not.toBeNull();
  });
});
