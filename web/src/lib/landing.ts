/* The signed-out landing page's content model: which screenshots it shows,
   what it says in each section, and which doors it opens. Kept apart from the
   component so the copy keys and assets can be checked without a DOM. */

/** Relay is open source (MIT); the landing page points visitors at the
    public repository so they can read, self-host, and contribute. */
export const RELAY_GITHUB_URL = "https://github.com/droxer/Relay";
export const RELAY_CLONE_COMMAND = `git clone ${RELAY_GITHUB_URL}.git`;

/** A product screenshot under public/landing/, captured by
    script/readme-snapshots (`--theme dark|light`) and saved as 1600px WebP,
    plus an 800px cut for one-density screens and narrow layouts
    (`cwebp -q 80 -m 6 -resize 800 0 <shot>.webp -o <shot>-800w.webp`).
    Each ships English and zh-CN cuts in both themes. */
export type LandingShot = "threads" | "projects" | "issues" | "routines" | "teams";

export const LANDING_HERO_SHOT: LandingShot = "threads";

/** Intrinsic size of every shot, so the browser reserves the box before the
    image arrives and nothing below it jumps. */
export const LANDING_SHOT_SIZE = { width: 1600, height: 1000 } as const;

/** The register a screenshot was captured in; each shot ships a cut per
    theme so the product pictured matches the page around it. */
export type LandingTheme = "dark" | "light";

/** Widths each shot ships at, smallest first; the last is the full cut. */
export const LANDING_SHOT_WIDTHS = [800, LANDING_SHOT_SIZE.width] as const;

/** How wide a shot renders, for `sizes`: the hero spans the page measure
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
  const languageSuffix = language === "zh-CN" ? "-zh-CN" : "";
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
    Threads is the hero's picture, so the tour opens on the next surface. */
export const LANDING_TOUR: readonly LandingTourItem[] = [
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
