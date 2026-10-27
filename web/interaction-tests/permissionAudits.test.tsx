import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AgentStream } from "../src/components/AgentStream";

it.each(["allow", "allow_always", "allow_granted"] as const)("keeps the complete %s command available on its tool line", (outcome) => {
  const command = "# shared setup\n".repeat(30) + "printf '%s' 'a  b'";
  const stdout = JSON.stringify({ type: "assistant", message: { content: [
    { type: "tool_use", id: "toolu_1", name: "Bash", input: { command } },
  ] } }) + "\n";
  const { container } = render(<AgentStream
    agent="claude" stdout={stdout} stderr="" streaming={false} collaborations={[]}
    permissions={[{ id: "allow_1", toolName: "Bash", toolUseId: "toolu_1", outcome, tone: "info", label: "You allowed Bash", detail: command }]}
  />);

  expect(screen.getByText(`agent_stream.permission.${outcome}`).getAttribute("title")).toBe(`You allowed Bash · ${command}`);
  expect(container.querySelectorAll(".agent-tool .agent-permission-mark")).toHaveLength(1);
  expect(container.querySelectorAll(".agent-permission-line")).toHaveLength(0);
});
