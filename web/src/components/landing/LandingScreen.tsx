"use client";

import { useEffect, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWaitlistEnabled } from "../../hooks/useAuthStatus";
import { useResolvedTheme } from "../../hooks/useResolvedTheme";
import type { Theme } from "../../lib/appStorage";
import {
  LANDING_HERO_SHOT,
  LANDING_HERO_SIZES,
  LANDING_PRINCIPLES,
  LANDING_SHOT_SIZE,
  LANDING_STEPS,
  LANDING_TOUR,
  LANDING_TOUR_SIZES,
  RELAY_CLONE_COMMAND,
  landingCtas,
  landingShotSrc,
  landingShotSrcSet,
  type LandingCta,
  type LandingShot,
} from "../../lib/landing";
import { RelayMark } from "../RelayMark";
import { ICON, ThemeDark, ThemeLight } from "../icons";
import { PublicLink } from "../waitlist/PublicLink";
import { GithubLink, GithubMark } from "./GithubMark";

const HOW_ID = "landing-how";
const PRODUCT_ID = "landing-product";

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
    window. Only the hero loads eagerly; the tour waits until it is near. */
function Shot({ shot, alt, priority = false }: { shot: LandingShot; alt: string; priority?: boolean }) {
  const { i18n } = useTranslation();
  const theme = useResolvedTheme();
  return (
    <figure className="landing-shot">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); pre-sized webp screenshots */}
      <img
        src={landingShotSrc(shot, i18n.language, theme)}
        srcSet={landingShotSrcSet(shot, i18n.language, theme)}
        sizes={priority ? LANDING_HERO_SIZES : LANDING_TOUR_SIZES}
        alt={alt}
        width={LANDING_SHOT_SIZE.width}
        height={LANDING_SHOT_SIZE.height}
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

function SectionHead({ id, title }: { id: string; title: string }) {
  return (
    <header className="landing-section-head">
      <h2 className="landing-section-title" id={id}>{title}</h2>
    </header>
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
 * The signed-out front door at `/`: what Relay is, how it works, the product
 * as it really looks, and the one or two doors in. It follows the visitor's
 * theme — saved, or the system's — and shows the product in the same one.
 */
export function LandingScreen({ onThemeChange }: { onThemeChange?: (theme: Theme) => void }) {
  const { t } = useTranslation();
  const ctas = landingCtas(useWaitlistEnabled());
  const year = new Date().getFullYear();

  /* The page names what Relay does, in the visitor's language; signing in
     hands the tab back to the app's own title. */
  useEffect(() => {
    document.title = t("landing.page_title");
    return () => {
      document.title = t("app.title");
    };
  }, [t]);

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav-inner">
          <Brand />
          <nav className="landing-nav-links" aria-label={t("landing.nav_label")}>
            <SectionLink id={HOW_ID} className="landing-nav-link" label={t("landing.nav_how")} />
            <SectionLink id={PRODUCT_ID} className="landing-nav-link" label={t("landing.nav_product")} />
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
        <section className="landing-hero" aria-labelledby="landing-headline">
          <div className="landing-hero-copy">
            <h1 className="landing-headline" id="landing-headline">{t("landing.headline")}</h1>
            <p className="landing-lede">{t("landing.lede")}</p>
            <div className="landing-ctas">
              <CtaLink cta={ctas.primary} tone="primary" />
              {ctas.secondary ? (
                <CtaLink cta={ctas.secondary} tone="secondary" />
              ) : (
                <SectionLink id={HOW_ID} className="landing-button landing-button-secondary" label={t("landing.cta_secondary")} />
              )}
            </div>
            <p className="landing-runtimes">{t("landing.runtimes")}</p>
          </div>
          <div className="landing-hero-shot">
            <Shot shot={LANDING_HERO_SHOT} alt={t("landing.hero_alt")} priority />
          </div>
        </section>

        <section className="landing-section" id={HOW_ID} tabIndex={-1} aria-labelledby="landing-how-title">
          <SectionHead id="landing-how-title" title={t("landing.how_title")} />
          <ol className="landing-steps">
            {LANDING_STEPS.map((step) => (
              <li className="landing-step" key={step.titleKey}>
                <h3 className="landing-card-title">{t(step.titleKey)}</h3>
                <p className="landing-card-body">{t(step.bodyKey)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section" id={PRODUCT_ID} tabIndex={-1} aria-labelledby="landing-product-title">
          <SectionHead id="landing-product-title" title={t("landing.product_title")} />
          <div className="landing-tour">
            {LANDING_TOUR.map((item) => (
              <article className="landing-tour-row" key={item.shot}>
                <div className="landing-tour-copy">
                  <h3 className="landing-tour-title">{t(item.titleKey)}</h3>
                  <p className="landing-tour-body">{t(item.bodyKey)}</p>
                </div>
                <Shot shot={item.shot} alt={t(item.altKey)} />
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section" aria-labelledby="landing-principles-title">
          <SectionHead id="landing-principles-title" title={t("landing.principles_title")} />
          <ul className="landing-principles">
            {LANDING_PRINCIPLES.map((item) => (
              <li className="landing-principle" key={item.titleKey}>
                <h3 className="landing-card-title">{t(item.titleKey)}</h3>
                <p className="landing-card-body">{t(item.bodyKey)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-section" aria-labelledby="landing-oss-title">
          <div className="landing-oss">
            <div className="landing-oss-copy">
              <SectionHead id="landing-oss-title" title={t("landing.oss_title")} />
              <p className="landing-card-body">{t("landing.oss_body")}</p>
              <div className="landing-ctas landing-ctas-start">
                <GithubLink className="landing-button landing-button-secondary landing-button-icon">
                  <GithubMark size={ICON.md} />
                  <span>{t("landing.oss_cta")}</span>
                </GithubLink>
              </div>
            </div>
            <figure className="landing-terminal">
              <figcaption className="landing-terminal-label">{t("landing.oss_clone_label")}</figcaption>
              <code className="landing-terminal-command">{RELAY_CLONE_COMMAND}</code>
            </figure>
          </div>
        </section>

        <section className="landing-closer" aria-labelledby="landing-closer-title">
          <RelayMark size={ICON.hero} tone="brand" />
          <h2 className="landing-section-title" id="landing-closer-title">{t("landing.cta_title")}</h2>
          <p className="landing-lede">{t(ctas.secondary ? "landing.cta_body" : "landing.cta_body_signin")}</p>
          <div className="landing-ctas">
            <CtaLink cta={ctas.primary} tone="primary" />
            {ctas.secondary ? <CtaLink cta={ctas.secondary} tone="secondary" /> : null}
          </div>
        </section>
      </main>

      <footer className="landing-foot">
        <div className="landing-foot-inner">
          <Brand />
          <span className="landing-foot-tagline">{t("landing.foot_tagline")}</span>
          <GithubLink className="landing-foot-github" label={t("landing.github")}>
            <GithubMark size={ICON.md} />
          </GithubLink>
          <span className="landing-foot-meta">© {year} Relay</span>
        </div>
      </footer>
    </div>
  );
}
