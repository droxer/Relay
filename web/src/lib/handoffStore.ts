import { create } from "zustand";

// Draft for the "hand off to another agent" panel in the decision bar. It is
// written by the panel (DecisionBar), read at send time by useThreadDispatch,
// and kept routable by App as the thread's roster changes — three places that
// previously shared it through six drilled props.
interface HandoffDraftStore {
  open: boolean;
  agentId: string;
  note: string;

  setOpen: (open: boolean) => void;
  setAgentId: (agentId: string) => void;
  setNote: (note: string) => void;
  // A delivered handoff closes the panel and drops the note; the target stays
  // so a follow-up handoff defaults to the same agent.
  finishSend: () => void;
}

export const useHandoffStore = create<HandoffDraftStore>((set) => ({
  open: false,
  agentId: "",
  note: "",

  setOpen: (open) => set({ open }),
  setAgentId: (agentId) => set({ agentId }),
  setNote: (note) => set({ note }),
  finishSend: () => set({ open: false, note: "" }),
}));
