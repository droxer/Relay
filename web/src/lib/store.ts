import { create } from "zustand";
import { writeTokens, type TokenMap } from "./appStorage.ts";
import { DEFAULT_ADMIN_SECTION, type AdminSection } from "./viewTypes.ts";

/** The control panel's section ids live with the other route vocabularies in
    viewTypes; the store only mirrors which one is open so the mobile topbar
    can name it. */
export type AdminPageView = AdminSection;

const ACTIVE_SESSION_PREFIX = "relay.activeSession.";

/** Where the thread an employee last opened is remembered across reloads. */
export function activeSessionStorageKey(employeeId: string): string {
  return ACTIVE_SESSION_PREFIX + employeeId;
}

function rememberActiveSession(employeeId: string, sessionId: string | null): void {
  if (!employeeId || typeof localStorage === "undefined") return;
  const key = activeSessionStorageKey(employeeId);
  if (sessionId) localStorage.setItem(key, sessionId);
  else localStorage.removeItem(key);
}

// Cross-cutting client state for the main app shell: which employee/session is
// open and the per-employee/sandbox auth tokens. Server state stays in TanStack
// Query; this store is only the local selection + UI state that was previously
// threaded through App's useState + props.
interface RelayClientStore {
  selectedEmployee: string;
  /** The thread explicitly opened (URL, click, or a dispatch that returned). */
  selectedSessionId: string | undefined;
  /** The thread shown when nothing is explicitly selected; remembered per employee. */
  activeSessionId: string | null;
  /** Staging a brand-new thread: suppresses the fall-back to a recent thread. */
  composingNew: boolean;
  tokens: TokenMap;
  adminView: AdminPageView;

  setSelectedEmployee: (id: string) => void;
  setSelectedSessionId: (id: string | undefined) => void;
  /** Sets and remembers the active thread for the selected employee. */
  setActiveSessionId: (id: string | null) => void;
  /** Sets the active thread from a derived pick without remembering it. */
  adoptActiveSessionId: (id: string | null) => void;
  setComposingNew: (composingNew: boolean) => void;
  /** Open one thread: select it, make it active, stop composing. */
  openSession: (id: string) => void;
  /** Stage a brand-new thread with nothing selected. */
  startComposing: () => void;
  /** Deselect every thread without changing whether one is being composed. */
  clearSelection: () => void;
  // Persists to localStorage so callers no longer pair set + write by hand.
  setTokens: (tokens: TokenMap) => void;
  setAdminView: (view: AdminPageView) => void;
}

export const useRelayStore = create<RelayClientStore>((set, get) => ({
  selectedEmployee: "",
  selectedSessionId: undefined,
  activeSessionId: null,
  composingNew: false,
  tokens: {},
  adminView: DEFAULT_ADMIN_SECTION,

  setSelectedEmployee: (selectedEmployee) => set({ selectedEmployee }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setActiveSessionId: (activeSessionId) => {
    rememberActiveSession(get().selectedEmployee, activeSessionId);
    set({ activeSessionId });
  },
  adoptActiveSessionId: (activeSessionId) => set({ activeSessionId }),
  setComposingNew: (composingNew) => set({ composingNew }),
  openSession: (id) => {
    rememberActiveSession(get().selectedEmployee, id);
    set({ composingNew: false, selectedSessionId: id, activeSessionId: id });
  },
  startComposing: () => {
    rememberActiveSession(get().selectedEmployee, null);
    set({ composingNew: true, selectedSessionId: undefined, activeSessionId: null });
  },
  clearSelection: () => {
    rememberActiveSession(get().selectedEmployee, null);
    set({ selectedSessionId: undefined, activeSessionId: null });
  },
  setTokens: (tokens) => {
    writeTokens(tokens);
    set({ tokens });
  },
  setAdminView: (adminView) => set({ adminView }),
}));
