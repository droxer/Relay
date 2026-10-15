export type SkillVisibility = "private" | "org";
export type SkillSource = "authored" | "upload" | "git";
export interface SkillFileInput { path: string; contentBase64: string }
export interface SkillRevision { id: string; revision: number; bytes: number; manifestSha256: string; createdAt: string; createdByUserId: string; note?: string | null }
export interface SkillFileSummary { path: string; sha256: string; bytes: number }
export interface SkillAssignment {
  id: string;
  skillId: string;
  targetType: "user" | "team" | "project" | "agent" | "org";
  targetId: string;
  mode: "optional" | "required" | "suggested";
  pin: "stable" | "latest" | { revisionId: string };
  invocation: "implicit" | "explicit";
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}
export interface SkillRecord {
  id: string;
  ownerUserId: string;
  namespace: string;
  name: string;
  slug: string;
  displayName: string;
  description: string;
  visibility: SkillVisibility;
  source: SkillSource;
  sourceRef?: { url: string; ref: string; subpath: string } | null;
  currentRevisionId: string;
  stableRevisionId: string;
  createdAt: string;
  updatedAt: string;
  grantedAgentCount?: number;
  assignmentCount?: number;
}
export interface SkillDetail extends SkillRecord {
  revisions: SkillRevision[];
  files: SkillFileSummary[];
  grantedAgentIds: string[];
  assignments: SkillAssignment[];
}
export interface SkillsResponse { skills: SkillRecord[] }
/** One bundle file read back for preview — text only, capped server-side. */
export interface SkillFilePreview {
  path: string;
  bytes: number;
  sha256: string;
  binary: boolean;
  truncated: boolean;
  content: string;
}
