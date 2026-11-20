import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ChannelsPage } from "../src/components/ChannelsPage";
import { DialogProvider } from "../src/components/ui/DialogProvider";
import { configurePersonalQueryCache } from "../src/lib/personalQueryCache";

it("loads the routing roster on demand and reuses it when the picker reopens", async () => {
  const integration = {
    id: "channel", displayName: "Telegram account", provider: "telegram", status: "draft",
    config: {}, health: { ok: false, message: "" }, secretKeys: [], secretConfigured: false,
    identityLinkCount: 0, allowedConversationCount: 0, identityLinks: [], allowedConversations: [],
  };
  const fetchRoute = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input), "https://relay.test").pathname;
    if (path.endsWith("/chat-integrations")) return Response.json({ integrations: [integration] });
    if (path.endsWith("/agents")) return Response.json({ agents: [] });
    return Response.json({ nodes: [] });
  });
  vi.stubGlobal("fetch", fetchRoute);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  configurePersonalQueryCache(client);
  render(<QueryClientProvider client={client}><DialogProvider><ChannelsPage /></DialogProvider></QueryClientProvider>);
  const requests = () => fetchRoute.mock.calls.map(([url]) => new URL(String(url), "https://relay.test").pathname);
  const picker = await screen.findByRole("combobox", { name: "admin.v2.chat_agent_placeholder" });
  expect(requests()).toEqual(["/api/v1/admin/chat-integrations"]);

  fireEvent.keyDown(picker, { key: "ArrowDown" });
  await waitFor(() => expect(requests()).toContain("/api/v1/admin/agents"));
  expect(requests()).not.toContain("/api/v1/admin/daemon-nodes");
  fireEvent.keyDown(picker, { key: "Escape" });
  fireEvent.change(screen.getByRole("textbox", { name: "admin.v2.placeholder_user_id" }), { target: { value: "owner" } });
  fireEvent.keyDown(picker, { key: "ArrowDown" });
  await waitFor(() => expect(requests()).toContain("/api/v1/admin/daemon-nodes"));
  expect(requests().filter(path => path.endsWith("/agents"))).toHaveLength(1);
});
