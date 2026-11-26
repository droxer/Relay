import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MessageBlock, type DerivedMessage } from "../src/components/MessageBlock";
import { DialogProvider } from "../src/components/ui/DialogProvider";

const timestamp = "2026-11-26T12:00:00.000Z";

function renderInDialog(ui: React.ReactElement) {
  return render(<DialogProvider>{ui}</DialogProvider>);
}

describe("Thread internal UI polish", () => {
  it("renders leading @agent mentions in user messages with emphasized .msg-mention spans", async () => {
    const message: DerivedMessage = {
      kind: "user",
      id: "u1",
      timestamp,
      text: "@Frigg @Ada 请帮我优化这个页面的交互",
    };

    const { container } = renderInDialog(
      <MessageBlock
        message={message}
        sessionId="ses_1"
        logicalAgentNames={{ a1: "Frigg", a2: "Ada" }}
      />,
    );

    await waitFor(() => {
      const mentions = [...container.querySelectorAll(".msg-mention")].map((el) => el.textContent);
      expect(mentions).toEqual(["@Frigg", "@Ada"]);
    });
    expect(container.textContent).toContain("请帮我优化这个页面的交互");
  });

  it("copies user message text via the user turn copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue(undefined);
    renderInDialog(
      <MessageBlock
        message={{ kind: "user", id: "u2", timestamp, text: "@Frigg copy me" }}
        sessionId="ses_1"
        logicalAgentNames={{ a1: "Frigg" }}
      />,
    );

    const copyBtn = screen.getByRole("button", { name: "message.copy" });
    await user.click(copyBtn);
    expect(writeText).toHaveBeenCalledWith("@Frigg copy me");
    writeText.mockRestore();
  });

  it("triggers quick @mention reply from an eligible agent turn", async () => {
    const onMentionAgent = vi.fn();
    const user = userEvent.setup();

    renderInDialog(
      <MessageBlock
        message={{
          kind: "agent",
          id: "m1",
          runId: "r1",
          timestamp,
          agent: "claude",
          agentId: "a1",
          stdout: "Done!",
          stderr: "",
          streaming: false,
          collaborations: [],
          attachments: [],
        }}
        sessionId="ses_1"
        logicalAgentNames={{ a1: "Frigg" }}
        onMentionAgent={onMentionAgent}
        mentionableAgentIds={new Set(["a1"])}
      />,
    );

    const mentionBtn = screen.getByRole("button", { name: /message\.mention_agent/i });
    await user.click(mentionBtn);
    expect(onMentionAgent).toHaveBeenCalledWith("Frigg");
  });

  it("emphasizes inline @agent mentions in agent-authored replies while skipping inline code", async () => {
    const stdout = [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "text",
              text: "I updated the API; @Frigg please polish the UI.\n\n- Sync with @Support Bot on logs\n- Keep `@Frigg` literal in code and ignore dev@Ada.com",
            },
          ],
        },
      }),
    ].join("\n");

    const { container } = renderInDialog(
      <MessageBlock
        message={{
          kind: "agent",
          id: "m2",
          runId: "r2",
          timestamp,
          agent: "claude",
          agentId: "a2",
          stdout,
          stderr: "",
          streaming: false,
          collaborations: [],
          attachments: [],
        }}
        sessionId="ses_1"
        logicalAgentNames={{ a1: "Frigg", a2: "Ada", a3: "Support Bot" }}
      />,
    );

    await waitFor(() => {
      const mentions = [...container.querySelectorAll(".msg-mention")].map((el) => el.textContent);
      expect(mentions).toEqual(["@Frigg", "@Support Bot"]);
    });
    const codeEls = [...container.querySelectorAll("code")];
    expect(codeEls.some((el) => el.textContent === "@Frigg" && el.querySelector(".msg-mention") === null)).toBe(true);
  });

  it("makes eligible @agent pills clickable to address that agent in the composer and keeps unavailable ones inert", async () => {
    const onMentionAgent = vi.fn();
    const user = userEvent.setup();
    const stdout = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "Handing off to @frigg while @Ada is offline." }],
      },
    });

    const { container } = renderInDialog(
      <MessageBlock
        message={{
          kind: "agent",
          id: "m3",
          runId: "r3",
          timestamp,
          agent: "claude",
          agentId: "a3",
          stdout,
          stderr: "",
          streaming: false,
          collaborations: [],
          attachments: [],
        }}
        sessionId="ses_1"
        logicalAgentNames={{ a1: "Frigg", a2: "Ada", a3: "Lead" }}
        onMentionAgent={onMentionAgent}
        mentionableAgentIds={new Set(["a1"])}
      />,
    );

    const friggBtn = await screen.findByRole("button", { name: "@frigg" });
    await user.click(friggBtn);
    expect(onMentionAgent).toHaveBeenCalledWith("Frigg");

    const adaPill = [...container.querySelectorAll(".msg-mention")].find((el) => el.textContent === "@Ada");
    expect(adaPill?.tagName).toBe("SPAN");
  });
});
