import type { Tone } from "../types";
import type { StatusValue } from "./threadStatus";

// Canonical status → tone mapping: live work (running/busy/provisioning) is
// info, queued/paused (pending/stopped) is warn, ready/done is good, and a
// failure is bad. Truly unknown values fall through to neutral so a new
// backend state never silently masquerades as a warning. Per-domain mappers
// (adminHelpers, agentPlacements) follow these same semantics for their own
// status vocabularies.
//
// Absence is not failure. `--err` means something went wrong and someone has
// to act; an agent that is simply not connected, or a computer that has not
// checked in lately, is the resting state of half a roster. Painting those
// red makes a quiet workforce look like an incident and spends the loudest
// tone in the palette on the most common condition — so `offline` takes the
// ink ramp and `stale` takes the amber it is already drawn with in the
// control panel's fleet readout.
export function statusTone(value: StatusValue): Tone {
  switch (value) {
    case "ready":
    case "completed":
    case "done":
      return "good";
    case "running":
    case "busy":
    case "provisioning":
      return "info";
    case "pending":
    case "stopped":
    case "stale":
      return "warn";
    case "offline":
      return "neutral";
    case "failed":
    case "blocked":
    case "cancelled":
      return "bad";
    default:
      return "neutral";
  }
}
