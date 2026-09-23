import { expect, it } from "vitest";
import { statusTone as channelTone } from "../src/components/admin/ChannelPrimitives";

/* Absence and choice are not failure. Relay has one critical tone, and every
   per-domain status mapper spends it only on something that actually broke —
   see lib/statusTone.ts for the canonical rule these follow. */

it("keeps a switched-off channel out of the critical tone", () => {
  // Disabled is an operator's decision. A real fault reports through the
  // integration's `health`, which renders as its own line under the name.
  expect(channelTone("disabled")).toBe("neutral");
  expect(channelTone("draft")).toBe("neutral");
});

it("still separates a working channel from an impaired one", () => {
  expect(channelTone("active")).toBe("good");
  expect(channelTone("degraded")).toBe("warn");
});
