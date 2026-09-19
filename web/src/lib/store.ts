import { create } from "zustand";
import { writeTokens, type TokenMap } from "./appStorage";
import { DEFAULT_ADMIN_SECTION, type AdminSection } from "./viewTypes";

/** The control panel's section ids live with the other route vocabularies in
    viewTypes; the store only mirrors which one is open so the mobile topbar
    can name it. */
export type AdminPageView = AdminSection;

// Cross-cutting client state for the main app shell: which employee/session is
// open and the per-employee/sandbox auth tokens. Server state stays in TanStack
// Query; this store is only the local selection + UI state that was previously
// threaded through App's useState + props.
interface RelayClientStore {
  selectedEmployee: string;
  selectedSessionId: string | undefined;
  tokens: TokenMap;
  adminView: AdminPageView;

  setSelectedEmployee: (id: string) => void;
  setSelectedSessionId: (id: string | undefined) => void;
  // Persists to localStorage so callers no longer pair set + write by hand.
  setTokens: (tokens: TokenMap) => void;
  setAdminView: (view: AdminPageView) => void;
}

export const useRelayStore = create<RelayClientStore>((set) => ({
  selectedEmployee: "",
  selectedSessionId: undefined,
  tokens: {},
  adminView: DEFAULT_ADMIN_SECTION,

  setSelectedEmployee: (selectedEmployee) => set({ selectedEmployee }),
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setTokens: (tokens) => {
    writeTokens(tokens);
    set({ tokens });
  },
  setAdminView: (adminView) => set({ adminView }),
}));
