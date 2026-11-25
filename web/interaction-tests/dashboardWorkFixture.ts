import type { DashboardWorkResponse } from "../src/api";

export const emptyDashboardWork: DashboardWorkResponse = {
  projects: { total: 0, enabled: 0, disabled: 0, archived: 0, created: 0, activeInRange: 0 },
  tasks: {
    total: 0, open: 0, created: 0, done: 0, inProgress: 0, blocked: 0, backlog: 0,
    cancelled: 0, inProjects: 0, standalone: 0, statusCounts: {},
  },
  conversations: {
    total: 0, chats: 0, totalChats: 0, projectChats: 0, standaloneChats: 0, taskRuns: 0, automationRuns: 0,
  },
};
