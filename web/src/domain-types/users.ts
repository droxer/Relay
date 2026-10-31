import type { ControlPanelDaemonNodeRecord } from "relay-core";
import type { Language, Theme } from "../lib/appStorage.ts";

export interface UserRecord {
  id: string;
  /** The @handle. `id` is a UUID under the database auth store, so this — not
      the id — is what the admin surfaces render. Optional only for records
      from a backend that predates the column. */
  handle?: string;
  displayName: string;
  email?: string;
  departmentId?: string;
  departmentName?: string;
  /** Pinned personal-computer limit; null/undefined means it follows the org default. */
  maxLocalComputers?: number | null;
  /** The override when there is one, the org default otherwise. Resolved server-side. */
  effectiveMaxLocalComputers?: number;
  /** Live personal computers the user currently owns. */
  localComputerCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface OrgSettings {
  maxLocalComputersPerUser: number;
  /** How many extra rounds a task may run when it reports itself unfinished. */
  maxTaskRounds: number;
  updatedAt?: string | null;
}

export interface OrgSettingsResponse {
  settings: OrgSettings;
  capabilities?: {
    /** False when the auth store cannot hold user edits (name, email, limit). */
    userEdits?: boolean;
    /** True when the public waitlist join is open. Inviting by email works
        either way; this only decides whether people can ask. */
    waitlist?: boolean;
    /** True when an invite goes out by email (mail and a public web URL are
        configured). False, the admin copies each link by hand. */
    inviteEmail?: boolean;
  };
  /** Whether an admin bearer token exists. Only its hash is stored, so the
      value itself comes back once, from the reissue route. */
  adminTokenConfigured?: boolean;
}

export interface UpdateControlPanelUserInput {
  userId: string;
  displayName?: string;
  email?: string;
  /** `null` clears the override so the user follows the org default again. */
  maxLocalComputers?: number | null;
}

export interface ControlPanelUsersResponse {
  users: UserRecord[];
}

export interface CreateControlPanelUserInput {
  userId: string;
  username: string;
  password: string;
  nodeId?: string;
  email?: string;
  displayName?: string;
  maxLocalComputers?: number | null;
}

export interface CreateControlPanelUserResponse {
  user: UserRecord;
  account: CurrentUser;
  node?: ControlPanelDaemonNodeRecord;
  /** Set when the user was created but the requested computer could not be
      attached (someone else claimed it first). The user is still real — the
      admin resolves the computer from the assign flow. */
  assignmentError?: string;
}

export type UserRole = "admin" | "user";

export interface CurrentUser {
  id: string;
  username: string;
  email?: string;
  role: UserRole;
  userId?: string;
  displayName?: string;
  theme?: Theme;
  language?: Language;
  /** Pinned local-computer limit; null/undefined means it follows the org default. */
  maxLocalComputers?: number | null;
  /** Resolved local-computer limit for this user, decorated by /auth/me. */
  effectiveMaxLocalComputers?: number;
  /** Live local computers this user owns, decorated by /auth/me. */
  localComputerCount?: number;
  /** The onboarding wizard's stored choices; progress itself is derived
      (lib/onboarding.ts). */
  onboarding?: OnboardingPrefs;
  /** Home queue items this person snoozed, each held while its stamp is
   *  unchanged (`backend/relay/security/home_snoozes.py`). */
  homeSnoozes?: HomeSnooze[];
}

export type OnboardingCard = "tasks" | "projects" | "teams" | "automations";

/** The account's onboarding choices, stamped by the server. */
export interface OnboardingPrefs {
  introSeenAt?: string;
  dismissedAt?: string;
  closedCards?: readonly OnboardingCard[];
}

export interface HomeSnooze {
  key: string;
  stamp: string;
}

/** A change to the snoozed set; the server keeps the newest entries. */
export interface HomeSnoozesPatch {
  snooze?: HomeSnooze[];
  unsnooze?: string[];
}
