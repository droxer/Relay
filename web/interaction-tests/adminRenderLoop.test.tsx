import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { expect, it, vi } from "vitest";

import * as api from "../src/api";
import * as controlPanelQueries from "../src/lib/controlPanelQueries";
import { AdminPage } from "../src/components/AdminPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import type { CurrentUser } from "../src/types";

const ADMIN = { id: "u1", username: "admin", role: "admin", userId: "e1" } as unknown as CurrentUser;

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return createElement(QueryClientProvider, { client }, createElement(DialogProvider, null, children));
}

it("renders while the node poll is still in flight", () => {
  // jsdom has no SVG geometry (and no SVGPathElement global); the dashboard
  // chart measures its line on mount.
  // @ts-expect-error jsdom lacks SVG geometry APIs
  Element.prototype.getTotalLength = () => 100;
  // Never resolve: nodesQuery.data stays undefined, so the hook returns its
  // empty fallback. A fresh `[]` identity per render made useKeyChange(nodes)
  // set state on every render pass — "Too many re-renders" on first visit.
  const pending = () => new Promise<never>(() => {});
  vi.spyOn(controlPanelQueries, "fetchControlPanelNodes").mockImplementation(pending);
  vi.spyOn(api, "listControlPanelUsers").mockImplementation(pending);
  vi.spyOn(api, "getOrgSettings").mockImplementation(pending);

  const { container } = render(
    <AdminPage currentUser={ADMIN} section="dashboard" onSelectSection={() => {}} />,
    { wrapper },
  );

  expect(container.innerHTML.length).toBeGreaterThan(0);
});
