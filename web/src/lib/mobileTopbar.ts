import type { AppRoute, MobileView } from "./viewTypes.ts";

const WORK_ROUTE_LABEL_KEYS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  home: "nav.home",
  backlog: "nav.backlog",
  routine: "nav.routine",
  agents: "nav.agents",
  teams: "nav.teams",
  computers: "nav.computers",
  skills: "nav.skills",
  settings: "nav.settings",
  channels: "nav.channels",
  admin: "nav.admin",
};

export type MobileTopbarMode = {
  /** The route shows the thread directory or a conversation. */
  threadRoute: boolean;
  /** A conversation is open: back arrow, thread chrome, no tab bar. */
  chat: boolean;
  /** The title's i18n key; null means the open thread's own label. */
  titleKey: string | null;
  /** Where the back arrow returns to, and its accessible name. */
  directoryKey: string;
};

/** One title line on every route: the open thread in a conversation, the
 *  directory ("Threads", "Projects") over its list, and the route's own name
 *  everywhere else. Admin and settings name the SURFACE — the section strip
 *  under the bar already marks the section. An unknown path parses as `main`
 *  but is never a conversation, so it gets a page title of its own. */
export function mobileTopbarMode({ route, notFound, taskThread, taskWorkspace, mobileView }: {
  route: AppRoute;
  notFound: boolean;
  taskThread: boolean;
  taskWorkspace: boolean;
  mobileView: MobileView;
}): MobileTopbarMode {
  const directoryKey = taskThread ? "thread.back_to_task" : route === "projects" ? "project.projects" : "nav.threads";
  if (notFound) return { threadRoute: false, chat: false, titleKey: "route_not_found.title", directoryKey };
  const threadRoute = taskThread || route === "main" || (route === "projects" && !taskWorkspace);
  const chat = threadRoute && mobileView === "chat";
  const titleKey = chat
    ? null
    : threadRoute
      ? directoryKey
      : taskWorkspace
        ? "nav.backlog"
        : WORK_ROUTE_LABEL_KEYS[route as keyof typeof WORK_ROUTE_LABEL_KEYS];
  return { threadRoute, chat, titleKey, directoryKey };
}
