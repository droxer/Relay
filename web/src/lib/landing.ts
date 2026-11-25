/* The signed-out landing page's content model: which screenshots it shows,
   what it says in each section, and which doors it opens. Kept apart from the
   component so the copy keys and assets can be checked without a DOM. */

/** Relay is open source (Apache-2.0); the landing page points visitors at the
    public repository so they can read, self-host, and contribute. */
export const RELAY_GITHUB_URL = "https://github.com/droxer/Relay";
export const RELAY_CLONE_COMMAND = `git clone ${RELAY_GITHUB_URL}.git`;
export const RELAY_START_COMMAND = "make backend && make daemon";

/** A product screenshot under public/landing/, captured by
    script/readme-snapshots (`--theme dark|light`) and saved as 1600px WebP,
    plus an 800px cut for one-density screens and narrow layouts
    (`cwebp -q 80 -m 6 -resize 800 0 <shot>.webp -o <shot>-800w.webp`).
    Each ships English and zh-CN cuts in both themes. */
export type LandingShot = "home" | "home-mobile" | "threads" | "projects" | "issues" | "routines" | "teams";

export const LANDING_HERO_SHOT: LandingShot = "home";

/** Editorial studio photographs under public/landing/ (1600w + 800w WebP). */
export const LANDING_PHOTOS = {
  heroDesk: {
    src: "/landing/hero-desk.webp",
    srcSet: "/landing/hero-desk-800w.webp 800w, /landing/hero-desk.webp 1600w",
    width: 1600,
    height: 900,
  },
  hardwareMacro: {
    src: "/landing/hardware-macro.webp",
    srcSet: "/landing/hardware-macro-800w.webp 800w, /landing/hardware-macro.webp 1200w",
    width: 1200,
    height: 750,
  },
} as const;

/** Intrinsic size of every shot, so the browser reserves the box before the
    image arrives and nothing below it jumps. */
export const LANDING_SHOT_SIZE = { width: 1600, height: 1000 } as const;
export const LANDING_PHONE_SHOT_SIZE = { width: 780, height: 1688 } as const;

/** The register a screenshot was captured in; each shot ships a cut per
    theme so the product pictured matches the page around it. */
export type LandingTheme = "dark" | "light";

/** Widths each shot ships at, smallest first; the last is the full cut. */
export const LANDING_SHOT_WIDTHS = [800, LANDING_SHOT_SIZE.width] as const;

/** How wide a shot renders, for `sizes`: the showcase spans the page measure
    (72rem), a tour shot two thirds of it beside its copy until the rows stack
    at 1040px. Slight overestimates only ever pick the sharper cut. */
export const LANDING_HERO_SIZES = "(min-width: 72rem) 72rem, 100vw";
export const LANDING_TOUR_SIZES = "(min-width: 1041px) 48rem, 100vw";

export function landingShotSrc(
  shot: LandingShot,
  language: string | undefined,
  theme: LandingTheme = "dark",
  width: number = LANDING_SHOT_SIZE.width,
): string {
  const themeSuffix = theme === "light" ? "-light" : "";
  const languageSuffix = language === "zh-CN" || language === "zh-TW" ? "-zh-CN" : "";
  const widthSuffix = width === LANDING_SHOT_SIZE.width ? "" : `-${width}w`;
  return `/landing/${shot}${themeSuffix}${languageSuffix}${widthSuffix}.webp`;
}

export function landingShotSrcSet(shot: LandingShot, language: string | undefined, theme: LandingTheme = "dark"): string {
  return LANDING_SHOT_WIDTHS.map((width) => `${landingShotSrc(shot, language, theme, width)} ${width}w`).join(", ");
}

export interface LandingStep {
  titleKey: string;
  bodyKey: string;
}

/** How it works, in the order a team meets Relay. */
export const LANDING_STEPS: readonly LandingStep[] = [
  { titleKey: "landing.step_enroll_title", bodyKey: "landing.step_enroll_body" },
  { titleKey: "landing.step_assign_title", bodyKey: "landing.step_assign_body" },
  { titleKey: "landing.step_review_title", bodyKey: "landing.step_review_body" },
];

export interface LandingTourItem {
  shot: LandingShot;
  titleKey: string;
  bodyKey: string;
  altKey: string;
}

/** The product tour: one surface per row, each shown as it really renders.
    Home leads the showcase, so the tour opens on Threads, where agents do the work. */
export const LANDING_TOUR: readonly LandingTourItem[] = [
  { shot: "threads", titleKey: "landing.tour_threads_title", bodyKey: "landing.tour_threads_body", altKey: "landing.tour_threads_alt" },
  { shot: "projects", titleKey: "landing.tour_projects_title", bodyKey: "landing.tour_projects_body", altKey: "landing.tour_projects_alt" },
  { shot: "issues", titleKey: "landing.tour_tasks_title", bodyKey: "landing.tour_tasks_body", altKey: "landing.tour_tasks_alt" },
  { shot: "routines", titleKey: "landing.tour_automations_title", bodyKey: "landing.tour_automations_body", altKey: "landing.tour_automations_alt" },
  { shot: "teams", titleKey: "landing.tour_teams_title", bodyKey: "landing.tour_teams_body", altKey: "landing.tour_teams_alt" },
];

export interface LandingPrinciple {
  titleKey: string;
  bodyKey: string;
}

export const LANDING_PRINCIPLES: readonly LandingPrinciple[] = [
  { titleKey: "landing.principle_local_title", bodyKey: "landing.principle_local_body" },
  { titleKey: "landing.principle_human_title", bodyKey: "landing.principle_human_body" },
  { titleKey: "landing.principle_record_title", bodyKey: "landing.principle_record_body" },
  { titleKey: "landing.principle_runtime_title", bodyKey: "landing.principle_runtime_body" },
];

export type LandingWorkflowTone = "good" | "live" | "warn" | "neutral";

export interface LandingWorkflowSlice {
  id: string;
  index: string;
  tone: LandingWorkflowTone;
  roleKey: string;
  statusKey: string;
  agentMeta: string;
  summaryKey: string;
  command: string;
  output: string;
}

/** Interactive 4-step workflow preview illustrating Relay's handoffs and human gates. */
export const LANDING_WORKFLOW_SLICES: readonly LandingWorkflowSlice[] = [
  {
    id: "architect",
    index: "01",
    tone: "good",
    roleKey: "landing.workflow_step_architect_role",
    statusKey: "landing.workflow_step_architect_status",
    agentMeta: "Codex · Mac Studio",
    summaryKey: "landing.workflow_step_architect_summary",
    command: "relay plan --scope billing/webhooks",
    output: "Spec written · 3 files scoped · handoff accepted",
  },
  {
    id: "engineer",
    index: "02",
    tone: "live",
    roleKey: "landing.workflow_step_engineer_role",
    statusKey: "landing.workflow_step_engineer_status",
    agentMeta: "Claude Code · Mac Studio",
    summaryKey: "landing.workflow_step_engineer_summary",
    command: "relay step 02 --verify",
    output: "queue/webhook.ts updated · 14/14 retry tests passed",
  },
  {
    id: "qa",
    index: "03",
    tone: "warn",
    roleKey: "landing.workflow_step_qa_role",
    statusKey: "landing.workflow_step_qa_status",
    agentMeta: "Pi · Linux Build Box",
    summaryKey: "landing.workflow_step_qa_summary",
    command: "relay gate await --approval owner",
    output: "Waiting for owner approval on migration diff",
  },
  {
    id: "reviewer",
    index: "04",
    tone: "neutral",
    roleKey: "landing.workflow_step_reviewer_role",
    statusKey: "landing.workflow_step_reviewer_status",
    agentMeta: "Google Antigravity · Mac Studio",
    summaryKey: "landing.workflow_step_reviewer_summary",
    command: "relay review --diff main..HEAD",
    output: "Queued after QA approval gate",
  },
];

export const LANDING_SUPPORTED_RUNTIMES = [
  "Codex",
  "Claude Code",
  "Pi",
  "OpenCode",
  "Google Antigravity",
] as const;

export interface LandingCta {
  href: string;
  labelKey: string;
}

/** The page's doors. Request access leads only while the server takes
    requests — a link to a form that answers 404 is a dead end — so an
    off or unknown waitlist leaves sign-in as the one action. */
export function landingCtas(waitlistEnabled: boolean | null): { primary: LandingCta; secondary: LandingCta | null } {
  const signIn: LandingCta = { href: "/login", labelKey: "landing.sign_in" };
  if (waitlistEnabled === true) {
    return { primary: { href: "/waitlist", labelKey: "landing.request_access" }, secondary: signIn };
  }
  return { primary: signIn, secondary: null };
}
