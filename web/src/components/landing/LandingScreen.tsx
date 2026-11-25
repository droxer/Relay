"use client";

import { useEffect, useState, type MouseEvent } from "react";
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
import { RelayMark } from "../RelayMark";
import { ActionCopy, CheckIcon, ICON, ThemeDark, ThemeLight } from "../icons";
import { PublicLink } from "../waitlist/PublicLink";
import { GithubLink, GithubMark } from "./GithubMark";

const HOW_ID = "landing-how";
const PRODUCT_ID = "landing-product";
const WORKFLOWS_ID = "landing-workflows";
const COMPUTERS_ID = "landing-computers";

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

/** A real screenshot of the product in the visitor's language, framed as a
    window. Only the hero showcase loads eagerly; the tour waits until near. */
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

/** Flips between the light and dark registers. The glyph and label name the
    theme a click moves to; the choice persists like any saved theme. */
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
 * The signed-out front door at `/`: eight art-directed sections covering the
 * architecture, workspace shell, project surfaces, multi-agent workflows,
 * local/cloud computers, open-source self-hosting, and conversion closer.
 */
export function LandingScreen({ onThemeChange }: { onThemeChange?: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const ctas = landingCtas(useWaitlistEnabled());
  const [activeSlice, setActiveSlice] = useState(1);
  const [copiedClone, setCopiedClone] = useState(false);
  const year = new Date().getFullYear();

  /* The page names what Relay does, in the visitor's language; signing in
     hands the tab back to the app's own title. */
  useEffect(() => {
    document.title = t("landing.page_title");
    return () => {
      document.title = t("app.title");
    };
  }, [t]);

  async function copyCloneCommand() {
    try {
      await navigator.clipboard?.writeText(`${RELAY_CLONE_COMMAND}\n${RELAY_START_COMMAND}`);
      setCopiedClone(true);
      window.setTimeout(() => setCopiedClone(false), 1800);
    } catch {
      // Clipboard may be unavailable in restricted contexts; command stays selectable.
    }
  }

  const [localPrinciple, humanPrinciple, recordPrinciple, runtimePrinciple] = LANDING_PRINCIPLES;

  return (
    <div className="landing">
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
            {/* Outline, not the plate: the hero's door is the one filled
                primary in view. */}
            <CtaLink cta={ctas.primary} tone="secondary" />
          </div>
        </div>
      </header>

      <main>
        {/* Section 1: Giant Statement Hero — bottom-left statement over studio hardware */}
        <section className="landing-hero" aria-labelledby="landing-headline">
          <div className="landing-hero-media" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element -- static export pre-sized studio photograph */}
            <img
              src={LANDING_PHOTOS.heroDesk.src}
              srcSet={LANDING_PHOTOS.heroDesk.srcSet}
              sizes="100vw"
              width={LANDING_PHOTOS.heroDesk.width}
              height={LANDING_PHOTOS.heroDesk.height}
              alt=""
              loading="eager"
              fetchPriority="high"
              decoding="async"
            />
          </div>
          <div className="landing-hero-inner">
            <div className="landing-hero-copy">
              <p className="landing-eyebrow code">{t("landing.hero_eyebrow")}</p>
              <h1 className="landing-headline" id="landing-headline">{t("landing.headline")}</h1>
              <p className="landing-lede">{t("landing.lede")}</p>
              <div className="landing-ctas landing-ctas-start">
                <CtaLink cta={ctas.primary} tone="primary" />
                {ctas.secondary ? (
                  <PublicLink href={ctas.secondary.href} className="landing-inline-link">
                    {t(ctas.secondary.labelKey)}
                    <span aria-hidden="true">→</span>
                  </PublicLink>
                ) : (
                  <SectionLink id={HOW_ID} className="landing-inline-link" label={`${t("landing.cta_secondary")} →`} />
                )}
              </div>
            </div>
            <div className="landing-hero-foot">
              <p className="landing-runtimes">{t("landing.runtimes")}</p>
              <span className="landing-hero-status code">
                <span className="landing-status-dot tone-live" aria-hidden="true" />
                {t("landing.hero_status")}
              </span>
            </div>
          </div>
        </section>

        {/* Section 2: Mini Minimalist Manifesto — off-grid offset + side-rail index */}
        <section className="landing-section landing-manifesto" id={HOW_ID} tabIndex={-1} aria-labelledby="landing-how-title">
          <div className="landing-manifesto-grid">
            <aside className="landing-side-rail" aria-hidden="true">
              <span className="landing-rail-num code">01</span>
              <span className="landing-rail-tick" />
              <span className="landing-rail-note code">{t("landing.manifesto_rail")}</span>
            </aside>
            <div className="landing-manifesto-main">
              <h2 className="landing-manifesto-title" id="landing-how-title">{t("landing.how_title")}</h2>
              <div className="landing-manifesto-offset">
                <ol className="landing-steps">
                  {LANDING_STEPS.map((step, index) => (
                    <li className="landing-step" key={step.titleKey}>
                      <span className="landing-step-index code">
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <h3 className="landing-card-title">{t(step.titleKey)}</h3>
                      <p className="landing-card-body">{t(step.bodyKey)}</p>
                    </li>
                  ))}
                </ol>
                <SectionLink id={PRODUCT_ID} className="landing-inline-link" label={`${t("landing.manifesto_link")} →`} />
              </div>
            </div>
          </div>
        </section>

        {/* Section 3: Workspace Shell Showcase — centered low caption under real app frame */}
        <section className="landing-section landing-showcase" id={PRODUCT_ID} tabIndex={-1} aria-labelledby="landing-product-title">
          <div className="landing-hero-shot">
            <div className="landing-hero-desktop">
              <Shot shot={LANDING_HERO_SHOT} alt={t("landing.hero_alt")} priority />
            </div>
            <div className="landing-hero-phone">
              <Shot shot="home-mobile" alt={t("landing.hero_mobile_alt")} priority />
            </div>
          </div>
          <div className="landing-showcase-caption">
            <div className="landing-showcase-lead">
              <span className="landing-section-index code">02 / {t("landing.nav_product")}</span>
              <h2 className="landing-section-title" id="landing-product-title">{t("landing.product_title")}</h2>
            </div>
            <div className="landing-showcase-support">
              <p className="landing-card-body">{t("landing.showcase_body")}</p>
              <SectionLink id={WORKFLOWS_ID} className="landing-inline-link" label={`${t("landing.showcase_link")} →`} />
            </div>
          </div>
        </section>

        {/* Section 4: Editorial Product Tour — 65/35 inverted & alternating surfaces */}
        <section className="landing-section landing-tour-section" aria-label={t("landing.product_title")}>
          <div className="landing-tour">
            {LANDING_TOUR.map((item, index) => (
              <article className="landing-tour-row" key={item.shot}>
                <div className="landing-tour-stage">
                  <Shot shot={item.shot} alt={t(item.altKey)} />
                </div>
                <div className="landing-tour-copy">
                  <span className="landing-section-index code">
                    {String(index + 1).padStart(2, "0")} / {t(item.titleKey)}
                  </span>
                  <h3 className="landing-tour-title">{t(item.titleKey)}</h3>
                  <p className="landing-tour-body">{t(item.bodyKey)}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* Section 5: Multi-Agent Workflows — color-blocked diptych + Hover-Accordion slices */}
        <section className="landing-section landing-workflows" id={WORKFLOWS_ID} tabIndex={-1} aria-labelledby="landing-workflows-title">
          <header className="landing-workflows-head">
            <div className="landing-workflows-lead">
              <span className="landing-section-index code">04 / {t("landing.nav_workflows")}</span>
              <h2 className="landing-section-title" id="landing-workflows-title">{t("landing.workflows_title")}</h2>
            </div>
            <SectionLink id={COMPUTERS_ID} className="landing-inline-link" label={`${t("landing.workflows_link")} →`} />
          </header>
          <div className="landing-accordion" role="list" aria-label={t("landing.workflows_title")}>
            {LANDING_WORKFLOW_SLICES.map((slice, index) => {
              const expanded = activeSlice === index;
              return (
                <div
                  key={slice.id}
                  role="listitem"
                  className={`landing-slice${expanded ? " is-expanded" : ""}`}
                  data-tone={slice.tone}
                  onMouseEnter={() => setActiveSlice(index)}
                >
                  <button
                    type="button"
                    className="landing-slice-trigger"
                    aria-expanded={expanded}
                    onClick={() => setActiveSlice(index)}
                    onFocus={() => setActiveSlice(index)}
                  >
                    <span className="landing-slice-top">
                      <span className="landing-slice-index code">{slice.index}</span>
                      <span className={`landing-slice-status tone-${slice.tone}`}>
                        <span className="landing-status-dot" aria-hidden="true" />
                        <span>{t(slice.statusKey)}</span>
                      </span>
                    </span>
                    <span className="landing-slice-role">{t(slice.roleKey)}</span>
                    <span className="landing-slice-meta code">{slice.agentMeta}</span>
                    {expanded ? (
                      <span className="landing-slice-detail">
                        <span className="landing-slice-summary">{t(slice.summaryKey)}</span>
                        <span className="landing-slice-receipt code">
                          <span>$ {slice.command}</span>
                          <span className="landing-slice-output">{slice.output}</span>
                        </span>
                      </span>
                    ) : null}
                  </button>
                </div>
              );
            })}
          </div>
        </section>

        {/* Section 6: Computers, Runtimes & Principles — Pristine Gapless Bento Grid */}
        <section className="landing-section landing-computers" id={COMPUTERS_ID} tabIndex={-1} aria-labelledby="landing-principles-title">
          <header className="landing-computers-head">
            <div className="landing-computers-lead">
              <span className="landing-section-index code">05 / {t("landing.nav_computers")}</span>
              <h2 className="landing-section-title" id="landing-principles-title">{t("landing.principles_title")}</h2>
            </div>
            <CtaLink cta={ctas.primary} tone="secondary" />
          </header>
          <div className="landing-bento">
            <article className="landing-bento-cell landing-bento-photo">
              {/* eslint-disable-next-line @next/next/no-img-element -- static export macro hardware photograph */}
              <img
                src={LANDING_PHOTOS.hardwareMacro.src}
                srcSet={LANDING_PHOTOS.hardwareMacro.srcSet}
                sizes="(min-width: 1041px) 36rem, 100vw"
                width={LANDING_PHOTOS.hardwareMacro.width}
                height={LANDING_PHOTOS.hardwareMacro.height}
                alt={t("landing.bento_photo_alt")}
                loading="lazy"
                decoding="async"
              />
              <div className="landing-bento-photo-copy">
                <h3 className="landing-bento-photo-title">{t(localPrinciple.titleKey)}</h3>
                <p className="landing-bento-photo-body">{t(localPrinciple.bodyKey)}</p>
              </div>
            </article>

            <article className="landing-bento-cell landing-bento-fleet">
              <span className="landing-bento-eyebrow code">{t("landing.bento_fleet_label")}</span>
              <h3 className="landing-card-title">{t(humanPrinciple.titleKey)}</h3>
              <p className="landing-card-body">{t(humanPrinciple.bodyKey)}</p>
              <ul className="landing-fleet-rows" aria-label={t("landing.bento_fleet_label")}>
                <li className="landing-fleet-row code">
                  <span className="landing-fleet-host">studio-macbook-pro</span>
                  <span className="landing-fleet-meta">macOS · BoxLite</span>
                  <span className="landing-fleet-state tone-live">
                    <span className="landing-status-dot" aria-hidden="true" />
                    2 / 5
                  </span>
                </li>
                <li className="landing-fleet-row code">
                  <span className="landing-fleet-host">linux-build-box</span>
                  <span className="landing-fleet-meta">Ubuntu · Host</span>
                  <span className="landing-fleet-state tone-good">
                    <span className="landing-status-dot" aria-hidden="true" />
                    Ready
                  </span>
                </li>
                <li className="landing-fleet-row code">
                  <span className="landing-fleet-host">fly-cloud-node-01</span>
                  <span className="landing-fleet-meta">Fly Machine</span>
                  <span className="landing-fleet-state tone-live">
                    <span className="landing-status-dot" aria-hidden="true" />
                    1 / 5
                  </span>
                </li>
              </ul>
            </article>

            <article className="landing-bento-cell landing-bento-runtimes">
              <span className="landing-bento-eyebrow code">{t(runtimePrinciple.titleKey)}</span>
              <ul className="landing-runtime-list">
                {LANDING_SUPPORTED_RUNTIMES.map((name) => (
                  <li key={name} className="landing-runtime-row">
                    <span className="landing-runtime-name">{name}</span>
                    <span className="landing-runtime-ready code tone-good">Ready</span>
                  </li>
                ))}
              </ul>
              <p className="landing-card-body">{t(runtimePrinciple.bodyKey)}</p>
            </article>

            <article className="landing-bento-cell landing-bento-record">
              <span className="landing-bento-eyebrow code">{t("landing.bento_record_label")}</span>
              <h3 className="landing-card-title">{t(recordPrinciple.titleKey)}</h3>
              <p className="landing-card-body">{t(recordPrinciple.bodyKey)}</p>
            </article>
          </div>
        </section>

        {/* Section 7: Open-Source & Self-Host — asymmetric 50/50 split */}
        <section className="landing-section landing-oss-section" aria-labelledby="landing-oss-title">
          <div className="landing-oss">
            <div className="landing-oss-card">
              <div className="landing-oss-card-head">
                <RelayMark size={ICON.lg} tone="brand" />
                <span className="landing-oss-card-label code">{t("landing.oss_stack_label")}</span>
              </div>
              <dl className="landing-oss-facts">
                <div className="landing-oss-fact">
                  <dt className="code">{t("landing.oss_fact_backend_label")}</dt>
                  <dd>Python · FastAPI · PostgreSQL / SQLite</dd>
                </div>
                <div className="landing-oss-fact">
                  <dt className="code">{t("landing.oss_fact_daemon_label")}</dt>
                  <dd>TypeScript · BoxLite · Host &amp; Fly Machines</dd>
                </div>
                <div className="landing-oss-fact">
                  <dt className="code">{t("landing.oss_fact_web_label")}</dt>
                  <dd>Next.js Static Export · SSE Live Streams</dd>
                </div>
              </dl>
            </div>

            <div className="landing-oss-copy">
              <span className="landing-section-index code">06 / APACHE-2.0</span>
              <h2 className="landing-section-title" id="landing-oss-title">{t("landing.oss_title")}</h2>
              <p className="landing-card-body">{t("landing.oss_body")}</p>
              <figure className="landing-terminal">
                <div className="landing-terminal-head">
                  <figcaption className="landing-terminal-label">{t("landing.oss_clone_label")}</figcaption>
                  <button
                    type="button"
                    className="landing-terminal-copy"
                    aria-label={t(copiedClone ? "landing.oss_copied" : "landing.oss_copy")}
                    onClick={() => void copyCloneCommand()}
                  >
                    {copiedClone ? <CheckIcon size={ICON.sm} aria-hidden="true" /> : <ActionCopy size={ICON.sm} aria-hidden="true" />}
                  </button>
                </div>
                <code className="landing-terminal-command">{RELAY_CLONE_COMMAND}</code>
                <code className="landing-terminal-command">{RELAY_START_COMMAND}</code>
              </figure>
              <div className="landing-ctas landing-ctas-start">
                <GithubLink className="landing-button landing-button-secondary landing-button-icon">
                  <GithubMark size={ICON.md} />
                  <span>{t("landing.oss_cta")}</span>
                </GithubLink>
              </div>
            </div>
          </div>
        </section>

        {/* Section 8: Mini Minimalist Closing CTA */}
        <section className="landing-closer" aria-labelledby="landing-closer-title">
          <span className="landing-closer-mark" aria-hidden="true">
            <RelayMark size={ICON.hero} tone="brand" />
          </span>
          <h2 className="landing-section-title" id="landing-closer-title">{t("landing.cta_title")}</h2>
          <p className="landing-lede">{t(ctas.secondary ? "landing.cta_body" : "landing.cta_body_signin")}</p>
          <div className="landing-ctas">
            <CtaLink cta={ctas.primary} tone="primary" />
            {ctas.secondary ? (
              <PublicLink href={ctas.secondary.href} className="landing-inline-link">
                {t(ctas.secondary.labelKey)}
                <span aria-hidden="true">→</span>
              </PublicLink>
            ) : null}
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-foot-inner">
          <div className="landing-foot-brand">
            <Brand />
            <span className="landing-foot-tagline">{t("landing.foot_tagline")}</span>
          </div>
          <nav className="landing-foot-links" aria-label={t("landing.nav_label")}>
            <SectionLink id={HOW_ID} className="landing-nav-link" label={t("landing.nav_how")} />
            <SectionLink id={PRODUCT_ID} className="landing-nav-link" label={t("landing.nav_product")} />
            <SectionLink id={WORKFLOWS_ID} className="landing-nav-link" label={t("landing.nav_workflows")} />
            <SectionLink id={COMPUTERS_ID} className="landing-nav-link" label={t("landing.nav_computers")} />
          </nav>
          <div className="landing-foot-end">
            <GithubLink className="landing-foot-github" aria-label={t("landing.github")}>
              <GithubMark size={ICON.md} />
            </GithubLink>
            <span className="landing-foot-meta code">© {year} Relay · Apache-2.0</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
