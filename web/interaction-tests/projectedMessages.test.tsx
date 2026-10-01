import { renderHook } from "@testing-library/react";
import type { TFunction } from "i18next";
import { expect, it } from "vitest";
import { useProjectedMessages } from "../src/hooks/useProjectedMessages";
import type { RelaySession } from "../src/types";

it("retains settled turns when applying new events and resets for a different thread", () => {
  const t = ((key: string) => key) as TFunction;
  const session = { id: "one", taskGoal: "Goal", createdAt: "2026-10-01", events: [] } as unknown as RelaySession;
  const { result, rerender } = renderHook(({ session, t }) => useProjectedMessages(session, t), { initialProps: { session: session as RelaySession | undefined, t } });
  const initial = result.current[0];
  rerender({ session: { ...session, events: [{ id: "message", sessionId: "one", type: "user.message", timestamp: "2026-10-01", text: "Next" }] }, t });
  expect(result.current[0]).toBe(initial);
  expect(result.current).toHaveLength(2);
  rerender({ session: { ...session, id: "two", taskGoal: "Different" }, t });
  expect(result.current).toHaveLength(1);
  expect(result.current[0]).toMatchObject({ text: "Different" });
  rerender({ session: undefined, t });
  expect(result.current).toEqual([]);
});
