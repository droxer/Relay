import type { AppRoute } from "./viewTypes.ts";

/* The code each work route needs beyond the app chunk, as the same dynamic
   imports WorkRoutePage's lazy components use: Turbopack puts both references
   in one chunk, so a prefetch here is the chunk the page then renders from.
   The threads surface (`main`, `projects`) is part of the app chunk already. */
const ROUTE_CHUNKS: Partial<Record<AppRoute, () => Promise<unknown>>> = {
  admin: () => import("../components/AdminPage"),
  backlog: () => import("../components/TasksWorkspace"),
  channels: () => import("../components/ChannelsPage"),
  routine: () => import("../components/RoutinesPage"),
  agents: () => import("../components/AgentsPage"),
  teams: () => import("../components/TeamsPage"),
  computers: () => import("../components/ComputerPage"),
  skills: () => import("../components/SkillsPage"),
  settings: () => import("../components/SettingsPage"),
};

/** Start fetching the route's own chunk now, beside the app chunk, instead
    of after the app has mounted and asked for it. A failure is the lazy
    component's to report when it renders. */
export function preloadRouteChunk(route: AppRoute): void {
  void ROUTE_CHUNKS[route]?.().catch(() => undefined);
}
