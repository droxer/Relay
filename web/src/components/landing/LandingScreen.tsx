"use client";

import { useEffect, useRef, useState, type FormEvent, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWaitlistEnabled } from "../../hooks/useAuthStatus";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import type { Theme } from "../../lib/appStorage";
import {
  LANDING_HERO_SHOT,
  LANDING_HERO_SIZES,
  LANDING_PHONE_SHOT_SIZE,
  LANDING_PHOTOS,
  LANDING_PRINCIPLES,
  LANDING_SHOT_SIZE,
  LANDING_STEPS,
  LANDING_SUPPORTED_RUNTIMES,
  LANDING_TOUR,
  LANDING_TOUR_SIZES,
  LANDING_WORKFLOW_SLICES,
  RELAY_CLONE_COMMAND,
  RELAY_START_COMMAND,
  landingCtas,
  landingShotSrc,
  landingShotSrcSet,
  type LandingCta,
  type LandingShot,
} from "../../lib/landing";
import { navigateToAppPath } from "../../lib/appRoute";
import { RelayMark } from "../RelayMark";
import { ActionCopy, CheckIcon, ICON, ThemeDark, ThemeLight } from "../icons";
import { PublicLink } from "../waitlist/PublicLink";
import { GithubLink, GithubMark } from "./GithubMark";

const HOW_ID = "landing-how";
const PRODUCT_ID = "landing-product";
const WORKFLOWS_ID = "landing-workflows";
const COMPUTERS_ID = "landing-computers";

type HeroComputer = {
  id: string;
  host: string;
  env: string;
  slots: string;
  workspace: string;
};

const HERO_COMPUTERS: readonly HeroComputer[] = [
  { id: "mac", host: "studio-macbook-pro", env: "macOS · BoxLite", slots: "2 / 5 active", workspace: "~/src/billing-api" },
  { id: "linux", host: "linux-build-box", env: "Ubuntu · Host", slots: "Ready", workspace: "/srv/relay/payments" },
  { id: "fly", host: "fly-cloud-node-01", env: "Fly Machine", slots: "1 / 5 active", workspace: "/workspace/core" },
] as const;

type ShowcasePrompt = {
  id: string;
  label: string;
  prompt: string;
  agent: string;
  runtime: string;
  computer: string;
  branch: string;
  files: readonly string[];
  check: string;
  gateQuestion: string;
};

const SHOWCASE_PROMPTS: readonly ShowcasePrompt[] = [
  {
    id: "webhook",
    label: "Webhook retries",
    prompt: "Fix the webhook retry race condition under concurrent deliveries and verify with unit tests.",
    agent: "Software Engineer",
    runtime: "Claude Code",
    computer: "studio-macbook-pro",
    branch: "fix/webhook-retry-lock",
    files: ["queue/webhook.ts", "tests/webhook.test.ts"],
    check: "14 / 14 retry tests passed in BoxLite",
    gateQuestion: "Approve migration diff before opening pull request?",
  },
  {
    id: "rate-limit",
    label: "Rate limiter",
    prompt: "Add per-tenant token bucket limits to the public API and document the 429 headers.",
    agent: "Architect → Software Engineer",
    runtime: "Codex",
    computer: "linux-build-box",
    branch: "feat/tenant-rate-limit",
    files: ["api/middleware/limits.py", "docs/api-limits.md"],
    check: "22 / 22 middleware checks passed",
    gateQuestion: "Allow default 120 req/min burst policy for free tier?",
  },
  {
    id: "audit",
    label: "Nightly audit",
    prompt: "Run nightly dependency audit on Fly Machine and file tasks for any critical advisories.",
    agent: "QA Engineer",
    runtime: "Pi",
    computer: "fly-cloud-node-01",
    branch: "chore/nightly-audit",
    files: ["reports/advisories.md", "tasks/upgrade-deps.json"],
    check: "0 critical · 2 minor upgrades queued",
    gateQuestion: "Approve opening two scheduled upgrade tasks?",
  },
] as const;

/* In-page jumps scroll by hand rather than through the URL hash: the app
   router reads the hash for its own state, and a landing anchor is not app
   state. Focus follows the scroll so keyboard users land where they jumped. */
function jumpTo(event: MouseEvent<HTMLAnchorElement>, id: string) {
  const target = document.getElementById(id);
  if (!target) return;
  event.preventDefault();
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
}

function SectionLink({ id, className, label }: { id: string; className: string; label: string }) {
  return (
    <a className={className} href={`#${id}`} onClick={(event) => jumpTo(event, id)}>
      {label}
    </a>
  );
}

function CtaLink({ cta, tone }: { cta: LandingCta; tone: "primary" | "secondary" }) {
  const { t } = useTranslation();
  return (
    <PublicLink href={cta.href} className={`landing-button landing-button-${tone}`}>
      {t(cta.labelKey)}
    </PublicLink>
  );
}

/** Split a headline cleanly into two authored lines for the masked-headline
    entrance without breaking localized strings. */
function splitHeadlineLines(headline: string): [string, string] | [string] {
  const words = headline.trim().split(/\s+/);
  if (words.length < 4) return [headline];
  const midpoint = Math.ceil(words.length / 2);
  return [words.slice(0, midpoint).join(" "), words.slice(midpoint).join(" ")];
}

/** A real screenshot of the product in the visitor's language, square-cropped
    on a flat surface. Only the workspace lead loads eagerly. */
function Shot({ shot, alt, priority = false }: { shot: LandingShot; alt: string; priority?: boolean }) {
  const { i18n } = useTranslation();
  const theme = useResolvedTheme();
  const phone = shot === "home-mobile";
  const size = phone ? LANDING_PHONE_SHOT_SIZE : LANDING_SHOT_SIZE;
  return (
    <figure className="landing-shot">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); pre-sized webp screenshots */}
      <img
        src={landingShotSrc(shot, i18n.language, theme)}
        srcSet={phone ? undefined : landingShotSrcSet(shot, i18n.language, theme)}
        sizes={phone ? undefined : priority ? LANDING_HERO_SIZES : LANDING_TOUR_SIZES}
        alt={alt}
        width={size.width}
        height={size.height}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : "auto"}
        decoding="async"
      />
    </figure>
  );
}

/** Flips between the light and dark registers. */
function ThemeToggle({ onThemeChange }: { onThemeChange: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const next = useResolvedTheme() === "dark" ? "light" : "dark";
  const label = t(next === "light" ? "landing.theme_to_light" : "landing.theme_to_dark");
  const Glyph = next === "light" ? ThemeLight : ThemeDark;
  return (
    <button type="button" className="landing-theme-toggle" aria-label={label} title={label} onClick={() => onThemeChange(next)}>
      <Glyph size={ICON.md} />
    </button>
  );
}

function Brand() {
  return (
    <PublicLink href="/" className="landing-brand">
      <RelayMark size={ICON.xl} tone="brand" />
      <span className="landing-wordmark">Relay</span>
    </PublicLink>
  );
}

/**
 * The signed-out front door at `/`: art-directed under "The product performs"
 * (Lunar & Bronze palette, Switzer neo-grotesk, working cropped UI fragments
 * marked data-ui, square-cropped real screenshots and hardware photography).
 */
export function LandingScreen({ onThemeChange }: { onThemeChange?: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const ctas = landingCtas(useWaitlistEnabled());
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* Live Hero Controls — "Controls on the sentence" */
  const [computerIndex, setComputerIndex] = useState(0);
  const [runtimeIndex, setRuntimeIndex] = useState(1);
  const [permissionMode, setPermissionMode] = useState<"ask" | "yolo">("ask");

  /* Live Input-Half / Output-Half Showcase */
  const [promptIndex, setPromptIndex] = useState(0);
  const [customPrompt, setCustomPrompt] = useState<string>(SHOWCASE_PROMPTS[0].prompt);
  const [gateDecision, setGateDecision] = useState<"pending" | "approved" | "changes">("pending");

  /* Interactive Annotated Panel + Workflow Slices */
  const [activeSlice, setActiveSlice] = useState(1);
  const [activeNote, setActiveNote] = useState<number | null>(null);

  /* Copyable CLI commands */
  const [copiedEnroll, setCopiedEnroll] = useState(false);
  const [copiedClone, setCopiedClone] = useState(false);

  /* Closing sentence-with-a-blank computer name */
  const [starterHost, setStarterHost] = useState("");

  const year = new Date().getFullYear();
  const activeComputer = HERO_COMPUTERS[computerIndex];
  const activeRuntime = LANDING_SUPPORTED_RUNTIMES[runtimeIndex];
  const activePreset = SHOWCASE_PROMPTS[promptIndex];
  const headlineLines = splitHeadlineLines(t("landing.headline"));

  useEffect(() => {
    document.title = t("landing.page_title");
    return () => {
      document.title = t("app.title");
    };
  }, [t]);

  /* Scroll-triggered staggered reveals — elements stay visible by default
     without JS; once IntersectionObserver mounts, off-screen targets transition
     smoothly into place on entry. */
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const nodes = Array.from(root.querySelectorAll<HTMLElement>("[data-reveal]"));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            entry.target.setAttribute("data-reveal", "visible");
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
    );

    for (const node of nodes) {
      const rect = node.getBoundingClientRect();
      if (rect.top < window.innerHeight * 0.92) {
        node.setAttribute("data-reveal", "visible");
      } else {
        node.setAttribute("data-reveal", "pending");
        observer.observe(node);
      }
    }

    return () => observer.disconnect();
  }, []);

  async function copyCommand(text: string, onDone: (v: boolean) => void) {
    try {
      await navigator.clipboard?.writeText(text);
      onDone(true);
      window.setTimeout(() => onDone(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts; command stays selectable.
    }
  }

  function selectPromptPreset(index: number) {
    setPromptIndex(index);
    setCustomPrompt(SHOWCASE_PROMPTS[index].prompt);
    setGateDecision("pending");
  }

  function handleStarterSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const destination = ctas.primary.href;
    const query = starterHost.trim() ? `?computer=${encodeURIComponent(starterHost.trim())}` : "";
    void navigateToAppPath(`${destination}${query}`);
  }

  const [localPrinciple, humanPrinciple, recordPrinciple, runtimePrinciple] = LANDING_PRINCIPLES;

  /* Six margin notes annotating the live workflow panel's parts directly. */
  const marginNotes = [
    { id: "routing", title: "Role-ordered handoffs", body: "Each step routes to its assigned role on the team’s computer, carrying the prior diff forward.", target: 0 },
    { id: "scope", title: "Scoped file targets", body: "The Architect locks the work scope and acceptance criteria before any code changes run.", target: 0 },
    { id: "stream", title: "Live command stream", body: "Watch every shell command, test run, and file edit stream in real time as the agent works.", target: 1 },
    { id: "sandbox", title: "BoxLite isolation", body: "Managed runs boot a dedicated guest per workspace so concurrent tasks never collide.", target: 1 },
    { id: "gates", title: "Human approval gates", body: t(humanPrinciple.bodyKey), target: 2 },
    { id: "review", title: "Structured review diff", body: "The Code Reviewer audits changes against project standards before you accept what ships.", target: 3 },
  ] as const;

  const leftNotes = marginNotes.slice(0, 3);
  const rightNotes = marginNotes.slice(3, 6);

  return (
    <div className="landing" ref={rootRef}>
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Brand />
          <nav className="landing-nav-links" aria-label={t("landing.nav_label")}>
            <SectionLink id={HOW_ID} className="landing-nav-link" label={t("landing.nav_how")} />
            <SectionLink id={PRODUCT_ID} className="landing-nav-link" label={t("landing.nav_product")} />
            <SectionLink id={WORKFLOWS_ID} className="landing-nav-link" label={t("landing.nav_workflows")} />
            <SectionLink id={COMPUTERS_ID} className="landing-nav-link" label={t("landing.nav_computers")} />
          </nav>
          <div className="landing-nav-actions">
            {onThemeChange ? <ThemeToggle onThemeChange={onThemeChange} /> : null}
            <GithubLink className="landing-nav-link landing-nav-github">
              <GithubMark size={ICON.md} />
              <span>{t("landing.github")}</span>
            </GithubLink>
            {ctas.secondary ? (
              <PublicLink href={ctas.secondary.href} className="landing-nav-link">
                {t(ctas.secondary.labelKey)}
              </PublicLink>
            ) : null}
            <CtaLink cta={ctas.primary} tone="secondary" />
          </div>
        </div>
      </header>

      <main>
        {/* ── 1. Hero: Controls on the sentence + live Relay execution chip bar ── */}
        <section className="landing-hero" aria-labelledby="landing-headline">
          <div className="landing-hero-inner">
            <div className="landing-hero-statement">
              <h1 className="landing-headline" id="landing-headline">
                {headlineLines.map((line, idx) => (
                  <span className="landing-headline-mask" key={idx}>
                    <span className={`landing-headline-line landing-headline-line-${idx + 1}`}>
                      {line}
                    </span>
                  </span>
                ))}
              </h1>

              {/* Live working product control strip — clicking mutates the live dispatch state */}
              <div data-ui="" className="landing-hero-dials" role="group" aria-label="Live Relay dispatch controls">
                <button
                  type="button"
                  className="landing-dial landing-dial-left"
                  onClick={() => setComputerIndex((i) => (i + 1) % HERO_COMPUTERS.length)}
                >
                  <span className="landing-dial-label">Computer</span>
                  <span className="landing-dial-value">{activeComputer.host}</span>
                  <span className="landing-dial-meta">{activeComputer.env}</span>
                </button>

                <button
                  type="button"
                  className="landing-dial landing-dial-mid"
                  onClick={() => setRuntimeIndex((i) => (i + 1) % LANDING_SUPPORTED_RUNTIMES.length)}
                >
                  <span className="landing-dial-label">Agent runtime</span>
                  <span className="landing-dial-value">{activeRuntime}</span>
                  <span className="landing-dial-meta">{activeComputer.slots}</span>
                </button>

                <div className="landing-dial landing-dial-right" role="group" aria-label="Permission mode">
                  <span className="landing-dial-label">Tool gate</span>
                  <div className="landing-dial-switch">
                    <button
                      type="button"
                      className={`landing-dial-opt${permissionMode === "ask" ? " is-active" : ""}`}
                      aria-pressed={permissionMode === "ask"}
                      onClick={() => setPermissionMode("ask")}
                    >
                      Ask me
                    </button>
                    <button
                      type="button"
                      className={`landing-dial-opt${permissionMode === "yolo" ? " is-active" : ""}`}
                      aria-pressed={permissionMode === "yolo"}
                      onClick={() => setPermissionMode("yolo")}
                    >
                      Auto
                    </button>
                  </div>
                </div>
              </div>

              <p className="landing-lede">{t("landing.lede")}</p>

              <div className="landing-ctas landing-ctas-start">
                <CtaLink cta={ctas.primary} tone="primary" />
                {ctas.secondary ? (
                  <PublicLink href={ctas.secondary.href} className="landing-inline-link">
                    {t(ctas.secondary.labelKey)}
                  </PublicLink>
                ) : (
                  <SectionLink id={HOW_ID} className="landing-inline-link" label={t("landing.cta_secondary")} />
                )}
              </div>
            </div>

            <div className="landing-hero-stage">
              <div className="landing-hero-photo-frame">
                {/* eslint-disable-next-line @next/next/no-img-element -- static export studio hardware photograph */}
                <img
                  className="landing-hero-photo"
                  src={LANDING_PHOTOS.heroDesk.src}
                  srcSet={LANDING_PHOTOS.heroDesk.srcSet}
                  sizes="(min-width: 1041px) 46vw, 100vw"
                  width={LANDING_PHOTOS.heroDesk.width}
                  height={LANDING_PHOTOS.heroDesk.height}
                  alt="Desktop workstation computer and laptop running Relay locally"
                  loading="eager"
                  fetchPriority="high"
                  decoding="async"
                />
              </div>
              <div data-ui="" className="landing-hero-dispatch" aria-live="polite">
                <div className="landing-dispatch-row">
                  <span className="landing-status-dot tone-live" aria-hidden="true" />
                  <span className="landing-dispatch-title">
                    {activeRuntime} on {activeComputer.host}
                  </span>
                  <span className="landing-dispatch-badge">
                    {permissionMode === "ask" ? "Pauses on tool calls" : "Auto-approves tools"}
                  </span>
                </div>
                <pre className="landing-dispatch-cmd">
                  <code>{`relay run --on ${activeComputer.host} --agent ${activeRuntime.toLowerCase().replace(/\s+/g, "-")} --${permissionMode}`}</code>
                </pre>
                <p className="landing-dispatch-foot">{t("landing.runtimes")}</p>
              </div>
            </div>
          </div>
        </section>

        {/* ── 2. Showcase: Input half (dark), Output half (light) ── */}
        <section className="landing-split-stage" id={PRODUCT_ID} tabIndex={-1} aria-labelledby="landing-product-title">
          <div className="landing-split-half landing-split-input">
            <div className="landing-split-content" data-reveal="idle">
              <div className="landing-preset-bar" role="group" aria-label="Sample task prompts">
                {SHOWCASE_PROMPTS.map((item, index) => (
                  <button
                    key={item.id}
                    type="button"
                    className={`landing-preset-btn${promptIndex === index ? " is-active" : ""}`}
                    aria-pressed={promptIndex === index}
                    onClick={() => selectPromptPreset(index)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <label className="landing-split-label" htmlFor="landing-live-prompt">
                Hand a request to your computer
              </label>
              <textarea
                id="landing-live-prompt"
                className="landing-split-textarea"
                rows={4}
                value={customPrompt}
                onChange={(event) => {
                  setCustomPrompt(event.target.value);
                  setGateDecision("pending");
                }}
              />
              <p className="landing-split-note">{t("landing.showcase_body")}</p>
            </div>
            <h2 className="landing-split-heading landing-split-heading-left" id="landing-product-title" data-reveal="idle">
              {t("landing.product_title")}
            </h2>
          </div>

          <div className="landing-split-half landing-split-output">
            <div className="landing-split-content" data-reveal="idle">
              <div data-ui="" className="landing-thread-card" aria-live="polite">
                <div className="landing-thread-head">
                  <div className="landing-thread-title-group">
                    <span className="landing-status-dot tone-live" aria-hidden="true" />
                    <span className="landing-thread-agent">{activePreset.agent}</span>
                  </div>
                  <span className="landing-thread-host">{activePreset.computer} · {activePreset.runtime}</span>
                </div>

                <p className="landing-thread-goal">{customPrompt.trim() || activePreset.prompt}</p>

                <div className="landing-thread-meta">
                  <span>Branch: {activePreset.branch}</span>
                  <span>{activePreset.files.join(", ")}</span>
                </div>

                <pre className="landing-thread-receipt">
                  <code>{`$ ${activePreset.check}`}</code>
                </pre>

                <div className="landing-thread-gate">
                  <p className="landing-thread-gate-q">{activePreset.gateQuestion}</p>
                  <div className="landing-thread-gate-actions">
                    <button
                      type="button"
                      className={`landing-gate-btn landing-gate-approve${gateDecision === "approved" ? " is-chosen" : ""}`}
                      aria-pressed={gateDecision === "approved"}
                      onClick={() => setGateDecision("approved")}
                    >
                      {gateDecision === "approved" ? "Approved" : "Approve step"}
                    </button>
                    <button
                      type="button"
                      className={`landing-gate-btn landing-gate-changes${gateDecision === "changes" ? " is-chosen" : ""}`}
                      aria-pressed={gateDecision === "changes"}
                      onClick={() => setGateDecision("changes")}
                    >
                      {gateDecision === "changes" ? "Changes requested" : "Request changes"}
                    </button>
                  </div>
                </div>
              </div>
            </div>
            <p className="landing-split-heading landing-split-heading-right" aria-hidden="true" data-reveal="idle">
              On your hardware
            </p>
          </div>
        </section>

        {/* ── 3. How it works: Call and response column + workspace breakout ── */}
        <section className="landing-section landing-call-response" id={HOW_ID} tabIndex={-1} aria-labelledby="landing-how-title">
          <div className="landing-cr-column">
            <h2 className="landing-section-title" id="landing-how-title" data-reveal="idle">
              {t("landing.how_title")}
            </h2>

            <ol className="landing-cr-list">
              <li className="landing-cr-exchange" data-reveal="idle">
                <h3 className="landing-cr-title">{t(LANDING_STEPS[0].titleKey)}</h3>
                <p className="landing-cr-body">{t(LANDING_STEPS[0].bodyKey)}</p>
                <div className="landing-cr-call">
                  <pre className="landing-cr-code">
                    <code>curl -fsSL https://relay.local/install.sh | sh &amp;&amp; relay daemon start</code>
                  </pre>
                  <button
                    type="button"
                    className="landing-copy-btn"
                    aria-label={t(copiedEnroll ? "landing.oss_copied" : "landing.oss_copy")}
                    onClick={() => void copyCommand("curl -fsSL https://relay.local/install.sh | sh && relay daemon start", setCopiedEnroll)}
                  >
                    {copiedEnroll ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
                  </button>
                </div>
                <div data-ui="" className="landing-cr-response">
                  <span className="landing-status-dot tone-good" aria-hidden="true" />
                  <span className="landing-cr-resp-main">studio-macbook-pro registered</span>
                  <span className="landing-cr-resp-sub">BoxLite sandbox · 5 runtimes ready</span>
                </div>
              </li>

              <li className="landing-cr-exchange" data-reveal="idle">
                <h3 className="landing-cr-title">{t(LANDING_STEPS[1].titleKey)}</h3>
                <p className="landing-cr-body">{t(LANDING_STEPS[1].bodyKey)}</p>
                <div className="landing-cr-call">
                  <pre className="landing-cr-code">
                    <code>relay task create &quot;Investigate dashboard chart slowdown&quot; --team platform</code>
                  </pre>
                </div>
                <div data-ui="" className="landing-cr-response">
                  <span className="landing-status-dot tone-live" aria-hidden="true" />
                  <span className="landing-cr-resp-main">Task #48 assigned to Platform Team</span>
                  <span className="landing-cr-resp-sub">Architect → Software Engineer → Code Reviewer</span>
                </div>
              </li>

              <li className="landing-cr-exchange landing-cr-exchange-final" data-reveal="idle">
                <h3 className="landing-cr-title">{t(LANDING_STEPS[2].titleKey)}</h3>
                <p className="landing-cr-body">{t(LANDING_STEPS[2].bodyKey)}</p>
                <div className="landing-cr-breakout">
                  <div className="landing-workspace-desktop">
                    <Shot shot={LANDING_HERO_SHOT} alt={t("landing.hero_alt")} priority />
                  </div>
                  <div className="landing-workspace-phone">
                    <Shot shot="home-mobile" alt={t("landing.hero_mobile_alt")} priority />
                  </div>
                </div>
              </li>
            </ol>
          </div>
        </section>

        {/* ── 4. Features & Workflows: Panel with margin notes + editorial tour plates ── */}
        <section className="landing-section landing-panel-notes" id={WORKFLOWS_ID} tabIndex={-1} aria-labelledby="landing-workflows-title">
          <div className="landing-notes-header" data-reveal="idle">
            <h2 className="landing-section-title" id="landing-workflows-title">
              {t("landing.workflows_title")}
            </h2>
            <SectionLink id={COMPUTERS_ID} className="landing-inline-link" label={t("landing.workflows_link")} />
          </div>

          <div className="landing-manual-grid">
            <div className="landing-margin-col landing-margin-left">
              {leftNotes.map((note, idx) => (
                <div
                  key={note.id}
                  className={`landing-margin-note${activeNote === note.target ? " is-active" : ""}`}
                  tabIndex={0}
                  onMouseEnter={() => {
                    setActiveNote(note.target);
                    setActiveSlice(note.target);
                  }}
                  onMouseLeave={() => setActiveNote(null)}
                  onFocus={() => {
                    setActiveNote(note.target);
                    setActiveSlice(note.target);
                  }}
                  onBlur={() => setActiveNote(null)}
                  data-reveal="idle"
                >
                  <p className="landing-note-title">{note.title}</p>
                  <p className="landing-note-body">{note.body}</p>
                  <span className="sr-only">Highlight step {idx + 1}</span>
                </div>
              ))}
            </div>

            <div data-ui="" className={`landing-manual-panel${activeNote !== null ? " is-focusing" : ""}`} data-reveal="idle">
              <div className="landing-panel-bar">
                <span className="landing-panel-name">Platform Pipeline · Mac Studio</span>
                <span className="landing-panel-state">Live round</span>
              </div>
              <div className="landing-panel-steps" role="list" aria-label={t("landing.workflows_title")}>
                {LANDING_WORKFLOW_SLICES.map((slice, index) => {
                  const expanded = activeSlice === index;
                  const dimmed = activeNote !== null && activeNote !== index;
                  return (
                    <div
                      key={slice.id}
                      role="listitem"
                      className={`landing-panel-step${expanded ? " is-expanded" : ""}${dimmed ? " is-dimmed" : ""}`}
                      data-tone={slice.tone}
                    >
                      <button
                        type="button"
                        className="landing-panel-trigger"
                        aria-expanded={expanded}
                        onClick={() => setActiveSlice(index)}
                        onMouseEnter={() => setActiveSlice(index)}
                      >
                        <span className="landing-panel-step-head">
                          <span className="landing-panel-role">{t(slice.roleKey)}</span>
                          <span className={`landing-panel-status tone-${slice.tone}`}>
                            <span className="landing-status-dot" aria-hidden="true" />
                            <span>{t(slice.statusKey)}</span>
                          </span>
                        </span>
                        <span className="landing-panel-meta">{slice.agentMeta}</span>
                        {expanded ? (
                          <span className="landing-panel-detail">
                            <span className="landing-panel-summary">{t(slice.summaryKey)}</span>
                            <code className="landing-panel-cmd">$ {slice.command}</code>
                            <span className="landing-panel-out">{slice.output}</span>
                          </span>
                        ) : null}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="landing-margin-col landing-margin-right">
              {rightNotes.map((note) => (
                <div
                  key={note.id}
                  className={`landing-margin-note${activeNote === note.target ? " is-active" : ""}`}
                  tabIndex={0}
                  onMouseEnter={() => {
                    setActiveNote(note.target);
                    setActiveSlice(note.target);
                  }}
                  onMouseLeave={() => setActiveNote(null)}
                  onFocus={() => {
                    setActiveNote(note.target);
                    setActiveSlice(note.target);
                  }}
                  onBlur={() => setActiveNote(null)}
                  data-reveal="idle"
                >
                  <p className="landing-note-title">{note.title}</p>
                  <p className="landing-note-body">{note.body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Editorial Product Plates — full clarity real screenshots, alternating asymmetrical spans */}
          <div className="landing-plates">
            {LANDING_TOUR.map((item, idx) => (
              <article
                className={`landing-plate landing-plate-${idx === 0 ? "wide" : idx % 2 === 1 ? "split" : "reverse"}`}
                key={item.shot}
                data-reveal="idle"
              >
                <div className="landing-plate-media">
                  <Shot shot={item.shot} alt={t(item.altKey)} />
                </div>
                <div className="landing-plate-copy">
                  <h3 className="landing-plate-title">{t(item.titleKey)}</h3>
                  <p className="landing-plate-body">{t(item.bodyKey)}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ── 5. Computers, Runtimes & Open-Source Self-Host Note ── */}
        <section className="landing-section landing-about" id={COMPUTERS_ID} tabIndex={-1} aria-labelledby="landing-principles-title">
          <div className="landing-about-top">
            <div className="landing-about-photo-col" data-reveal="idle">
              <figure className="landing-hardware-figure">
                {/* eslint-disable-next-line @next/next/no-img-element -- static export macro hardware photograph */}
                <img
                  src={LANDING_PHOTOS.hardwareMacro.src}
                  srcSet={LANDING_PHOTOS.hardwareMacro.srcSet}
                  sizes="(min-width: 1041px) 44vw, 100vw"
                  width={LANDING_PHOTOS.hardwareMacro.width}
                  height={LANDING_PHOTOS.hardwareMacro.height}
                  alt={t("landing.bento_photo_alt")}
                  loading="lazy"
                  decoding="async"
                />
              </figure>
              <div className="landing-about-lead">
                <h2 className="landing-section-title" id="landing-principles-title">
                  {t("landing.principles_title")}
                </h2>
                <p className="landing-about-body">{t(localPrinciple.bodyKey)}</p>
                <p className="landing-about-body">{t(recordPrinciple.bodyKey)}</p>
              </div>
            </div>

            <div className="landing-about-data-col" data-reveal="idle">
              <div data-ui="" className="landing-fleet-panel">
                <div className="landing-fleet-head">
                  <span className="landing-fleet-title">{t("landing.bento_fleet_label")}</span>
                  <span className="landing-fleet-count">3 online</span>
                </div>
                <ul className="landing-fleet-rows" aria-label={t("landing.bento_fleet_label")}>
                  {HERO_COMPUTERS.map((comp) => (
                    <li className="landing-fleet-row" key={comp.id}>
                      <span className="landing-fleet-host">{comp.host}</span>
                      <span className="landing-fleet-meta">{comp.env}</span>
                      <span className={`landing-fleet-state ${comp.slots === "Ready" ? "tone-good" : "tone-live"}`}>
                        <span className="landing-status-dot" aria-hidden="true" />
                        <span>{comp.slots}</span>
                      </span>
                    </li>
                  ))}
                </ul>

                <div className="landing-fleet-subhead">{t(runtimePrinciple.titleKey)}</div>
                <ul className="landing-runtime-list">
                  {LANDING_SUPPORTED_RUNTIMES.map((name) => (
                    <li key={name} className="landing-runtime-row">
                      <span className="landing-runtime-name">{name}</span>
                      <span className="landing-runtime-ready tone-good">Ready</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="landing-oss-note" data-reveal="idle">
                <h2 className="landing-oss-title" id="landing-oss-title">{t("landing.oss_title")}</h2>
                <p className="landing-about-body">{t("landing.oss_body")}</p>
                <div className="landing-oss-stack">
                  <p className="landing-oss-line">
                    <strong>{t("landing.oss_fact_backend_label")}:</strong> Python · FastAPI · PostgreSQL / SQLite
                  </p>
                  <p className="landing-oss-line">
                    <strong>{t("landing.oss_fact_daemon_label")}:</strong> TypeScript · BoxLite · Host &amp; Fly Machines
                  </p>
                  <p className="landing-oss-line">
                    <strong>{t("landing.oss_fact_web_label")}:</strong> Next.js Static Export · SSE Live Streams
                  </p>
                </div>
                <figure className="landing-terminal">
                  <div className="landing-terminal-head">
                    <figcaption className="landing-terminal-label">{t("landing.oss_clone_label")}</figcaption>
                    <button
                      type="button"
                      className="landing-copy-btn"
                      aria-label={t(copiedClone ? "landing.oss_copied" : "landing.oss_copy")}
                      onClick={() => void copyCommand(`${RELAY_CLONE_COMMAND}\n${RELAY_START_COMMAND}`, setCopiedClone)}
                    >
                      {copiedClone ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
                    </button>
                  </div>
                  <pre className="landing-terminal-pre">
                    <code className="landing-terminal-command">{RELAY_CLONE_COMMAND}</code>
                    <code className="landing-terminal-command">{RELAY_START_COMMAND}</code>
                  </pre>
                </figure>
                <div className="landing-ctas landing-ctas-start">
                  <GithubLink className="landing-button landing-button-secondary landing-button-icon">
                    <GithubMark size={ICON.md} />
                    <span>{t("landing.oss_cta")}</span>
                  </GithubLink>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ── 6. Closing CTA: A sentence with a blank ── */}
        <section className="landing-section landing-blank-cta" aria-labelledby="landing-closer-title">
          <form className="landing-blank-form" onSubmit={handleStarterSubmit} data-reveal="idle">
            <div className="landing-blank-head">
              <h2 className="landing-section-title" id="landing-closer-title">
                {t("landing.cta_title")}
              </h2>
              <p className="landing-blank-note">
                {t(ctas.secondary ? "landing.cta_body" : "landing.cta_body_signin")}
                {ctas.secondary ? (
                  <>
                    {" "}
                    <PublicLink href={ctas.secondary.href} className="landing-inline-link">
                      {t(ctas.secondary.labelKey)}
                    </PublicLink>
                  </>
                ) : null}
              </p>
            </div>
            <p className="landing-blank-sentence">
              <span>Name your computer </span>
              <input
                type="text"
                className="landing-blank-input"
                aria-label="Computer name"
                placeholder="mac-studio"
                value={starterHost}
                onChange={(event) => setStarterHost(event.target.value)}
              />
              <span> and </span>
              <button type="submit" className="landing-blank-submit">
                {t(ctas.primary.labelKey)}
              </button>
            </p>
          </form>
        </section>
      </main>

      {/* ── 7. Footer: Two-row flat tile board ── */}
      <footer className="landing-tiles-footer">
        <div className="landing-tiles-upper">
          <div className="landing-tile landing-tile-statement">
            <p className="landing-tile-pitch">{t("landing.foot_tagline")}</p>
            <p className="landing-tile-legal">© {year} Relay · Apache-2.0</p>
          </div>

          <nav className="landing-tile landing-tile-nav" aria-label={t("landing.nav_label")}>
            <SectionLink id={HOW_ID} className="landing-tile-link" label={t("landing.nav_how")} />
            <SectionLink id={PRODUCT_ID} className="landing-tile-link" label={t("landing.nav_product")} />
            <SectionLink id={WORKFLOWS_ID} className="landing-tile-link" label={t("landing.nav_workflows")} />
            <SectionLink id={COMPUTERS_ID} className="landing-tile-link" label={t("landing.nav_computers")} />
          </nav>

          <div className="landing-tile landing-tile-runtimes">
            <p className="landing-tile-list">
              Codex<br />
              Claude Code<br />
              Pi · OpenCode<br />
              Google Antigravity
            </p>
          </div>

          <div className="landing-tile landing-tile-repo">
            <GithubLink className="landing-tile-repo-link" label={t("landing.github")}>
              <GithubMark size={ICON.md} />
              <span>droxer/Relay</span>
            </GithubLink>
          </div>
        </div>

        <div className="landing-tiles-lower">
          <div className="landing-tile landing-tile-wordmark">
            <RelayMark size={ICON.hero} tone="brand" />
            <span className="landing-tile-giant-name">Relay</span>
          </div>

          <PublicLink href={ctas.primary.href} className="landing-tile landing-tile-accent">
            <span className="landing-tile-accent-label">{t(ctas.primary.labelKey)}</span>
            <svg
              className="landing-tile-arrow"
              viewBox="0 0 48 48"
              width="44"
              height="44"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M10 38 L38 10 M16 10 H38 V32"
                stroke="currentColor"
                strokeWidth="4"
                strokeLinecap="square"
                strokeLinejoin="miter"
              />
            </svg>
          </PublicLink>
        </div>
      </footer>
    </div>
  );
}
