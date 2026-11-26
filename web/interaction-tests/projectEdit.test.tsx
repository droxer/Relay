import { describe, expect, it } from "vitest";
import { projectMemberPatch, rebaseProjectEdit } from "../src/lib/projectEdit";
import type { ProjectMember, ProjectRecord, UpdateProjectInput } from "../src/types";

const a: ProjectMember = { agentId: "a", role: "implementer", responsibilities: "Build", enabled: true };
const b: ProjectMember = { ...a, agentId: "b" };
const base = { id: "p", version: 1, name: "Project", enabled: true, members: [a, b], leadAgentId: "a" } as ProjectRecord;
const latest = (patch: Partial<ProjectRecord> = {}): ProjectRecord => ({ ...base, version: 2, ...patch });
const input = (patch: Partial<UpdateProjectInput> = {}): UpdateProjectInput => ({ expectedVersion: 1, members: base.members, leadAgentId: "a", ...patch });

describe("project member Role Level", () => {
  it("sends the level when adding a Project Agent", () => {
    const member = { ...a, agentId: "c", roleLevel: "senior" } satisfies ProjectMember;
    expect(projectMemberPatch(base, input({ members: [a, b, member] }), member.agentId).memberChange).toEqual({
      op: "add", agentId: "c", fields: { role: a.role, roleLevel: "senior", responsibilities: a.responsibilities, enabled: true },
    });
  });

  it.each(["senior", null] as const)("sends a level-only update to %s", (roleLevel) => {
    const original = { ...base, members: [{ ...a, roleLevel: "junior" }, b] } satisfies ProjectRecord;
    const desired = { ...a, ...(roleLevel ? { roleLevel } : {}) };
    expect(projectMemberPatch(original, input({ members: [desired, b] }), a.agentId).memberChange).toEqual({
      op: "update", agentId: "a", fields: { roleLevel },
    });
  });

  it("keeps a level-only edit when retrying after a concurrent responsibility change", () => {
    const current = latest({ members: [{ ...a, responsibilities: "Ship" }, b] });
    const { patch, conflicts } = rebaseProjectEdit(base, input({ members: [{ ...a, roleLevel: "senior" }, b] }), current);
    expect(patch.members?.[0]).toEqual({ ...a, roleLevel: "senior", responsibilities: "Ship" });
    expect(conflicts).toEqual([]);
  });

  it("keeps a concurrent level change when the draft leaves it alone", () => {
    const current = latest({ members: [{ ...a, roleLevel: "junior" }, b] });
    const { patch, conflicts } = rebaseProjectEdit(base, input({ members: [{ ...a, responsibilities: "Ship" }, b] }), current);
    expect(patch.members?.[0]).toEqual({ ...a, roleLevel: "junior", responsibilities: "Ship" });
    expect(conflicts).toEqual([]);
  });
});

describe("project edit reconciliation", () => {
  it("preserves removal of an unedited sibling", () => {
    const result = rebaseProjectEdit(base, input({ members: [{ ...a, responsibilities: "My edit" }, b] }), latest({ members: [a] }));
    expect(result.patch.members).toEqual([{ ...a, responsibilities: "My edit" }]);
  });
  it("keeps a concurrent lead change when this draft only edits responsibilities", () => {
    const result = rebaseProjectEdit(base, input({ members: [{ ...a, responsibilities: "My edit" }, b] }), latest({ leadAgentId: "b" }));
    expect(result.patch.leadAgentId).toBe("b");
    expect(result.conflicts).toEqual([]);
  });
  it("does not replace a newer name when the name was unedited", () => {
    expect(rebaseProjectEdit(base, { expectedVersion: 1, name: base.name }, latest({ name: "New name" })).patch.name).toBe("New name");
  });
  it("clears instructions intentionally while preserving a concurrently changed role", () => {
    const original = { ...base, members: [{ ...a, instructions: "Old instructions" }, b] };
    const result = rebaseProjectEdit(original, input(), latest({ members: [{ ...a, instructions: "Old instructions", role: "reviewer" }, b] }));
    expect(result.patch.members?.[0]).toEqual({ ...a, role: "reviewer" });
  });
  it("adds a new member without dropping concurrent additions", () => {
    const c = { ...a, agentId: "c" };
    const d = { ...a, agentId: "d" };
    expect(rebaseProjectEdit(base, input({ members: [a, b, c] }), latest({ members: [a, b, d] })).patch.members).toEqual([a, b, d, c]);
  });
  it("rejects an agent added concurrently", () => {
    const c = { ...a, agentId: "c" };
    expect(() => rebaseProjectEdit(base, input({ members: [a, b, c] }), latest({ members: [a, b, c] }))).toThrow("project.edit_member_added");
  });
  it("shows current values before removing a concurrently edited member", () => {
    const result = rebaseProjectEdit(base, input({ members: [a] }), latest({ members: [a, { ...b, responsibilities: "New job" }] }));
    expect(result.conflicts[0].field).toBe("member_remove");
    expect(result.conflicts[0].saved).toContain("New job");
  });
  it("clears the lead when removing the last member", () => {
    expect(rebaseProjectEdit(base, input({ members: [], leadAgentId: null }), latest()).patch.leadAgentId).toBeNull();
  });
  it("refuses a retry that would leave a roster without an enabled lead", () => {
    expect(() => rebaseProjectEdit(base, input({ members: [b], leadAgentId: "b" }), latest({ members: [a, { ...b, enabled: false }] }))).toThrow("project.member_lead_required");
  });
  it.each([{ archivedAt: "today" }, { enabled: false }, { id: "different" }])("refuses closed or mismatched latest projects", (change) => {
    expect(() => rebaseProjectEdit(base, input(), latest(change))).toThrow("project.edit_closed");
  });
});

it("identifies a conflicting lead change with a translated field and member names", () => {
  const c = { ...a, agentId: "c" };
  const result = rebaseProjectEdit(base, input({ leadAgentId: "b" }), latest({ members: [a, b, c], leadAgentId: "c" }), { a: "A", b: "B", c: "C" });
  expect(result.conflicts).toEqual([{ field: "member_make_lead", member: undefined, saved: "C", draft: "B" }]);
});
