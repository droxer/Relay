"use client";

import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useWaitlistEnabled } from "../../hooks/useAuthStatus";
import {
  LANDING_HERO_SHOT,
  LANDING_PRINCIPLES,
  LANDING_SHOT_SIZE,
  LANDING_STEPS,
  LANDING_TOUR,
  landingCtas,
  landingShotSrc,
  type LandingCta,
  type LandingShot,
} from "../../lib/landing";
import { Chevrons } from "../AuthCanvas";
import { RelayMark } from "../RelayMark";
import { ICON } from "../icons";
import { PublicLink } from "../waitlist/PublicLink";

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
  return (
    <figure className="landing-shot">
      {/* eslint-disable-next-line @next/next/no-img-element -- static export (no next/image optimizer); pre-sized webp screenshots */}
      <img
        src={landingShotSrc(shot, i18n.language)}
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

function SectionHead({ id, kicker, title }: { id: string; kicker: string; title: string }) {
  return (
    <header className="landing-section-head">
      <p className="landing-kicker">{kicker}</p>
      <h2 className="landing-section-title" id={id}>{title}</h2>
    </header>
  );
}

function Brand() {
  return (
    <PublicLink href="/" className="landing-brand">
      <RelayMark size={ICON.xl} />
      <span className="landing-wordmark">Relay</span>
    </PublicLink>
  );
}

/**
 * The signed-out front door at `/`: what Relay is, how it works, the product
 * as it really looks, and the one or two doors in. It shares the sign-in
 * canvas's pinned dark register and chevron signature, so walking from here to
 * the gate reads as one place.
 */
export function LandingScreen() {
  const { t } = useTranslation();
  const ctas = landingCtas(useWaitlistEnabled());
  const year = new Date().getFullYear();

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
            {ctas.secondary ? (
              <PublicLink href={ctas.secondary.href} className="landing-nav-link">
                {t(ctas.secondary.labelKey)}
              </PublicLink>
            ) : null}
            <CtaLink cta={ctas.primary} tone="primary" />
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero" aria-labelledby="landing-headline">
          <span className="landing-bleed" aria-hidden="true">
            <Chevrons />
          </span>
          <div className="landing-hero-copy">
            <p className="landing-kicker">{t("landing.eyebrow")}</p>
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
          </div>
          <div className="landing-hero-shot">
            <Shot shot={LANDING_HERO_SHOT} alt={t("landing.hero_alt")} priority />
          </div>
        </section>

        <section className="landing-section" id={HOW_ID} tabIndex={-1} aria-labelledby="landing-how-title">
          <SectionHead id="landing-how-title" kicker={t("landing.how_kicker")} title={t("landing.how_title")} />
          <ol className="landing-steps">
            {LANDING_STEPS.map((step, index) => (
              <li className="landing-step" key={step.titleKey}>
                <span className="landing-step-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <h3 className="landing-card-title">{t(step.titleKey)}</h3>
                <p className="landing-card-body">{t(step.bodyKey)}</p>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section" id={PRODUCT_ID} tabIndex={-1} aria-labelledby="landing-product-title">
          <SectionHead id="landing-product-title" kicker={t("landing.product_kicker")} title={t("landing.product_title")} />
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
          <SectionHead id="landing-principles-title" kicker={t("landing.principles_kicker")} title={t("landing.principles_title")} />
          <ul className="landing-principles">
            {LANDING_PRINCIPLES.map((item) => (
              <li className="landing-principle" key={item.titleKey}>
                <Chevrons size={ICON.md} className="landing-principle-mark" />
                <h3 className="landing-card-title">{t(item.titleKey)}</h3>
                <p className="landing-card-body">{t(item.bodyKey)}</p>
              </li>
            ))}
          </ul>
        </section>

        <section className="landing-closer" aria-labelledby="landing-closer-title">
          <RelayMark size={ICON.hero} />
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
          <span className="landing-foot-meta">Relay · {year}</span>
        </div>
      </footer>
    </div>
  );
}
