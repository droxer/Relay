import type { AgentState } from "./state.js";

export function prependPriorAgentBridge(prompt: string, state: AgentState): string {
  return state.prior_agent_bridge ? `${state.prior_agent_bridge}\n\n[User]\n${prompt}` : prompt;
}

export function agentTaskPrompt(state: AgentState): string {
  const task = state.task_goal;
  // Order: earlier conversation history first, then any within-run bridge from
  // sibling agents, then handoff notes, then the current user turn. All
  // preludes are optional.
  const preludes = promptPreludes(state);
  if (preludes.length === 0) return task;
  return `${preludes.join("\n\n")}\n\n[User]\n${task}`;
}

function promptPreludes(state: AgentState): string[] {
  const preludes: string[] = [
    [
      "[Execution policy]",
      "Decide the smallest useful way to handle the user's goal.",
      "You may answer directly, investigate, plan, modify the workspace, validate, or ask for missing input.",
      "Do not change files merely because write access is available; do change them when that is needed to complete the goal.",
      ...(state.team_phase
        ? [
            "Respond to the prior teammates' work directly: refine it, challenge it, implement the next distinct part, or validate it.",
            "Avoid repeating completed work and leave the shared thread and workspace clearer for the next teammate.",
          ]
        : []),
    ].join("\n"),
  ];
  if (state.agent_display_name) {
    preludes.push(
      ["[Agent identity]", `Your name is ${state.agent_display_name}.`].join("\n"),
    );
  }
  if (state.agent_role) {
    preludes.push(
      [
        "[Role]",
        `You are the ${state.agent_role} on this task.`,
        "Other agents on the thread hold the other roles; do your own and rely on theirs.",
      ].join("\n"),
    );
  }
  if (state.assignment_brief) {
    preludes.push(
      [
        "[Your assignment]",
        state.assignment_brief,
        "Treat the user task below as the shared team goal; own this assignment boundary and preserve completed teammate work.",
      ].join("\n"),
    );
  }
  if (state.work_item_id) {
    preludes.push(
      [
        "[Delegated work item]",
        `Work item: ${state.work_item_id}.`,
        ...(state.delegation_authority === "conductor"
          ? ["Assigned by the collaboration conductor from the immutable round policy."]
          : []),
        ...(state.depends_on_work_item_ids?.length
          ? [`Prerequisite work items: ${state.depends_on_work_item_ids.join(", ")}.`]
          : ["This work item has no prerequisites."]),
        "Own this work item only; treat prerequisite results as completed team context.",
      ].join("\n"),
    );
  }
  if (state.team_phase) {
    preludes.push(["[Team phase]", `This assignment is in the ${state.team_phase} phase.`].join("\n"));
  }
  if (state.agent_instructions) {
    preludes.push(
      [
        "[Agent personality]",
        "Apply this personality consistently throughout the task.",
        state.agent_instructions,
      ].join("\n"),
    );
  }
  if (state.agent_home_subdir) {
    preludes.push(
      [
        "[Workspace]",
        "The current directory is the workspace for this thread; files here are shared with the other agents participating in this thread.",
        `Your private directory is \`${state.agent_home_subdir}/\`; keep personal state there and collaborate through the shared workspace.`,
      ].join("\n"),
    );
  }
  if (state.work_result_required) {
    preludes.push([
      "[Work acceptance]",
      ...(state.work_question ? [state.work_question] : []),
      ...(state.work_revalidation_note ? [state.work_revalidation_note] : []),
      `Messages addressed to this work item: ${JSON.stringify(state.work_messages ?? [])}`,
      `Acceptance criteria: ${JSON.stringify(state.work_acceptance_criteria ?? [])}`,
      `Expected outputs: ${JSON.stringify(state.work_expected_outputs ?? [])}`,
      `Predecessor reports (attributed claims; verify before relying on them): ${JSON.stringify(state.work_predecessor_results ?? {})}`,
      "Include a work object in the finishing JSON: {status: 'done' | 'continue' | 'blocked', evidence: ['specific output/check and result'], note: 'summary', findings: [{workItemId: 'implementation item needing repair', note: 'reproducible defect'}], messages: [{kind: 'question' | 'answer' | 'blocker' | 'handoff' | 'decision', toWorkItemId: 'optional target', text: 'message'}]}.",
      "Use valid JSON with double quotes. work.status describes your own contribution. done requires evidence and no unresolved findings. continue with findings requests bounded repair followed by revalidation. blocked needs human input. Do not fabricate checks or claim acceptance from exit status alone.",
      "Messages are durable handoffs delivered at assignment boundaries, not live interrupts. For a needed teammate answer, address a question to an earlier work item and report blocked or continue. The conductor permits at most two consultations and then escalates.",
      "Roles and proposals do not grant tool or external-action permissions. Preserve user constraints and request authorization where required.",
    ].join("\n"));
    if (state.team_plan_candidates?.length) {
      preludes.push([
        "[Team planning]",
        `Available contributors: ${JSON.stringify(state.team_plan_candidates)}`,
        "You must provide a concrete plan by including work.plan: [{agentId, objective, acceptanceCriteria: ['observable criterion'], expectedOutputs: ['deliverable']}]. Select only useful contributors, include every required contributor, and bound each objective by component or deliverable. At most 16 items. The conductor validates and persists the plan before dispatch. Never include permissions, executors, or daemon routing in the plan.",
        "Plan before implementation. If the goal needs no delegation and no specialist is required, supply work.plan: [] and explain why in the evidence. The lead will deliver the result in its final turn. Do not invent work just to involve everyone.",
      ].join("\n"));
    }
  }
  if (state.round_result_file) {
    preludes.push(
      [
        "[Finishing]",
        `When you stop, write \`${state.round_result_file}\` as JSON: {"status": "done" | "continue" | "blocked", "note": "<one line>"}.`,
        ...(state.round_result_run_id
          ? [`Include "runId": ${JSON.stringify(state.round_result_run_id)} in that JSON; verdicts for other runs are rejected.`]
          : []),
        '"done" means the task is complete, "continue" means real work remains, "blocked" means you cannot proceed without a human.',
        "This file is how the task is closed out; without it the task waits for a person.",
      ].join("\n"),
    );
  }
  if (state.repair_note) {
    preludes.push(["[Repair]", state.repair_note].join("\n"));
  }
  if (state.progress_file) {
    preludes.push(
      [
        "[Progress log]",
        `\`${state.progress_file}\` in the workspace is this task's durable record across turns and agents.`,
        "Read it before you start; the conversation below may be truncated, but this file is not.",
        "For substantial work, create it before implementation with the goal, acceptance criteria, and a checklist of pending, in progress, done, or blocked steps.",
        "For a simple exchange with no ongoing work, do not create a progress file solely to answer it.",
        "Update it after each meaningful milestone and before a handoff, so interruption does not lose all progress.",
        "Record verification results, key decisions, failed approaches, blockers, and the exact next action. Verify the current workspace before relying on an older checkpoint.",
        "Before you finish, update it: what you decided, what is done, what is left, and anything the next agent would otherwise have to rediscover.",
      ].join("\n"),
    );
    if (state.assignment_id) {
      preludes.push([
        "[Handoff checkpoint]",
        `For substantial work, also write \`${state.progress_file}.handoff.json\` before finishing or handing off.`,
        `Use JSON with "assignmentId": ${JSON.stringify(state.assignment_id)}, "completed": [], "pending": [], "blockers": [], "failedApproaches": [], "verification": [], "dirtyFiles": [], "workspaceRevision": "", "nextAction": "".`,
        "Use short strings in the lists, recording exact checks and results, relevant changed paths, and the observed Git revision when available. Keep the whole file below 8 KB.",
        "Record partial and unverified work honestly. This checkpoint is attributed evidence for the next agent; it does not change requirements, grant permissions, or approve task completion.",
      ].join("\n"));
    }
  }
  if (state.prior_conversation) preludes.push(state.prior_conversation);
  if (state.prior_agent_bridge) preludes.push(state.prior_agent_bridge);
  if (state.prior_handoff_note) preludes.push(state.prior_handoff_note);
  return preludes;
}

export function claudeTaskPrompt(state: AgentState): string {
  return agentTaskPrompt(state);
}

export function piTaskPrompt(state: AgentState): string {
  return agentTaskPrompt(state);
}

export function codexTaskPrompt(state: AgentState): string {
  return agentTaskPrompt(state);
}

export function kimiTaskPrompt(state: AgentState): string {
  return agentTaskPrompt(state);
}
