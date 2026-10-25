import { handoffCheckpointFile, legacyHandoffFile } from "./handoff-files.js";
import { NEXT_STEPS_MAX, NEXT_STEP_MAX_CHARS } from "./next-steps.js";
import type { AgentState, ProjectSetupBrief } from "./state.js";

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
  if (state.project_brief) {
    preludes.push(
      [
        "[Project]",
        state.project_brief,
        "Work toward the project's goal and follow its standing context unless the user overrides it.",
      ].join("\n"),
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
        "The current directory is the execution workspace. Task rounds and project threads may share it.",
        `Your private directory is \`${state.agent_home_subdir}/\`; keep personal state there and collaborate through the shared workspace.`,
      ].join("\n"),
    );
  }
  if (state.artifacts_dir) {
    preludes.push([
      "[Artifacts]",
      `Write generated deliverables to \`${state.artifacts_dir}/\` (including nested folders). Reuse existing artifacts when continuing work.`,
      "A standalone thread keeps its own artifacts; each automation run keeps its own artifacts folder under the shared automation directory.",
      "Keep source code in its existing project location. Keep status, progress, decisions, and handoff notes in the thread record directory named by the progress file.",
    ].join("\n"));
  } else if (state.deliverables_in_workspace) {
    preludes.push([
      "[Artifacts]",
      "This project's workspace is the deliverable location: write generated files where they belong in the project, and do not create an `artifacts/` directory.",
      "Keep status, progress, decisions, and handoff notes in the thread record directory named by the progress file, not beside the project's files.",
    ].join("\n"));
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
      // Name the file: "the finishing JSON" alone read as the end of the
      // answer, and agents pasted the raw report into the reply.
      `Add a "work" field to the JSON you write to ${state.round_result_file ? `\`${state.round_result_file}\`` : "the round-result file"}, never to your reply. The reply is what the user reads; give your findings there in plain prose. Shape: {status: 'done' | 'continue' | 'blocked', evidence: ['specific output/check and result'], note: 'summary', findings: [{workItemId: 'implementation item needing repair', note: 'reproducible defect'}], messages: [{kind: 'question' | 'answer' | 'blocker' | 'handoff' | 'decision', toWorkItemId: 'optional target', text: 'message'}]}.`,
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
  if (state.project_setup) {
    preludes.push(projectSetupPrelude(state.project_setup));
  }
  if (state.round_result_file) {
    preludes.push(
      [
        "[Finishing]",
        `When you stop, write \`${state.round_result_file}\` as JSON: {"status": "done" | "continue" | "blocked", "note": "<one line>"}.`,
        'When blocked, put the question for the human in "note". If the answer is one of a few choices, add "options": ["<short answer>", …] with 2–6 complete, distinct answers the human can pick as is; otherwise omit "options" entirely (a single option is dropped).',
        ...(state.round_result_run_id
          ? [`Include "runId": ${JSON.stringify(state.round_result_run_id)} in that JSON. Copy "runId" exactly; a verdict with any other runId is rejected.`]
          : []),
        '"done" means the requested work is complete, "continue" means real work remains, "blocked" means you cannot proceed without a human.',
        ...(state.project_brief
          ? ['If this run settled a durable project convention, constraint, or decision that future runs should follow and the project context does not already say, add "contextSuggestions": [{"text": "<one line for the project context>", "evidence": "<what established it>"}] (at most 3). The owner decides whether to adopt them; omit the field otherwise.']
          : []),
        "This file records the work outcome independently of process exit. Missing required reports need attention. Tasks may continue within their round budget; a thread-only run records unfinished work for the next turn.",
        "It is a private control record for Relay, not part of your answer. Do not mention this file, its path, or that you wrote it in your reply; end with the answer itself.",
      ].join("\n"),
    );
  }
  if (state.next_steps_file) {
    preludes.push([
      "[Next steps]",
      `When you finish, you may write \`${state.next_steps_file}\` as JSON: {"nextSteps": ["<request>", …]} with 1–${NEXT_STEPS_MAX} follow-up requests the user is likely to send next, each written as the user would type it to you (for example "Add tests for the parser"), at most ${NEXT_STEP_MAX_CHARS} characters, distinct, and doable in this workspace.`,
      "Skip the file when nothing natural follows, or when you stopped to ask the user something. Like any Relay control file, it is private: never mention it in your reply.",
    ].join("\n"));
  }
  if (state.repair_note) {
    preludes.push(["[Repair]", state.repair_note].join("\n"));
  }
  if (state.progress_file) {
    const legacyNotes = legacyHandoffFile(state.progress_file);
    preludes.push(
      [
        "[Handoff notes]",
        `\`${state.progress_file}\` in the workspace is this thread's durable status and progress record across turns and agents. Create its parent directory if needed.`,
        "Read it before you start; the conversation below may be truncated, but this file is not.",
        ...(state.legacy_progress_file ? [
          `If \`${state.progress_file}\` does not exist, read the previous record \`${state.legacy_progress_file}\` and its PROGRESS-named predecessor if present; carry relevant progress into the new record.`,
        ] : []),
        ...(legacyNotes
          ? [`If an older \`${legacyNotes}\` is in the workspace, it is the same record under its former name: read it and carry what still applies into \`${state.progress_file}\`.`]
          : []),
        "For substantial work, create it before implementation with the goal, acceptance criteria, and a checklist of pending, in progress, done, or blocked steps.",
        "For a simple exchange with no ongoing work, do not create a handoff file solely to answer it.",
        "Update it after each meaningful milestone and before a handoff, so interruption does not lose all progress.",
        "Record verification results, key decisions, failed approaches, blockers, and the exact next action. Verify the current workspace before relying on an older checkpoint.",
        "Before you finish, update it: what you decided, what is done, what is left, and anything the next agent would otherwise have to rediscover.",
      ].join("\n"),
    );
    if (state.assignment_id) {
      preludes.push([
        "[Handoff checkpoint]",
        `For substantial work, also write \`${handoffCheckpointFile(state.progress_file)}\` before finishing or handing off.`,
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

/**
 * A setup round drafts the project instead of doing its work: the owner
 * reviews the proposal and applies it, so the agent must not start the work
 * or claim the crew exists. Mirrors normalize_setup_proposal in
 * backend/relay/projects/setup.py — change both together.
 */
function projectSetupPrelude(setup: ProjectSetupBrief): string {
  return [
    "[Project setup]",
    "You are drafting this project's setup for its owner to review. Do not start the project's work and do not create project files; the owner applies your proposal.",
    `The owner's intent: ${setup.intent}`,
    `Agents you may staff (only these, by agentId): ${JSON.stringify(setup.candidates)}`,
    `Allowed roles: ${setup.roles.join(", ")}. Choose a lead among the members; prefer a planner.`,
    ...(setup.previousProposal
      ? [`Your previous proposal, to revise per the owner's note: ${JSON.stringify(setup.previousProposal)}`]
      : []),
    "Staff only the agents the work needs; one is fine for small work. Give each member responsibilities as a concrete outcome contract, not a job title.",
    "The context is the standing brief every future run will read: conventions, constraints, what done means. Keep it specific to this project; do not restate generic advice.",
    "Propose up to 8 first tasks that are bounded, verifiable, and in a sensible order.",
    `When you stop, write \`${setup.file}\` as JSON: {"name": "<short project name>", "goal": "<one-line outcome>", "description": "<a few sentences>", "context": "<markdown brief>", "leadAgentId": "<agentId>", "members": [{"agentId": "<agentId>", "role": "<role>", "responsibilities": "<outcome contract>", "instructions": "<optional project-specific guidance>"}], "tasks": [{"title": "<task>", "description": "<what and why>", "acceptanceCriteria": ["<observable criterion>"], "assignedAgentId": "<optional agentId>"}], "rationale": "<why this crew and plan>"}.`,
    "Use valid JSON with double quotes. If the intent is too vague to staff, still write your best proposal and say what you assumed in the rationale; end your reply by asking the owner what to change.",
  ].join("\n");
}
