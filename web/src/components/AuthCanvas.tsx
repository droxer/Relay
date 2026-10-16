"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RelayMark } from "./RelayMark";
import { ICON } from "./icons";
import { GithubLink, GithubMark } from "./landing/GithubMark";
import { PublicLink } from "./waitlist/PublicLink";

/* The double-chevron geometry, shared by the bled watermark and the proof
   marks so the cover is signed by one shape at two sizes. `size` is omitted
   for the watermark, which CSS sizes against the viewport instead. The
   landing page signs itself with the same shape. */
export function Chevrons({ size, className }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      aria-hidden="true"
      focusable="false"
      shapeRendering="geometricPrecision"
    >
      <g strokeWidth="7" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 14 L32 32 L12 50" stroke="currentColor" />
        <path d="M32 14 L52 32 L32 50" stroke="currentColor" opacity="0.45" />
      </g>
    </svg>
  );
}

/* Three things you can do with Relay, in the order you meet them: ask, hand
   off, stay in control. Verbs, not product tiers — a person at a sign-in
   screen is deciding whether to bother, and the answer to that is what the
   thing lets them do. */
const COVER_POINTS = ["login.do_ask", "login.do_handoff", "login.do_control"] as const;

/**
 * The signed-out canvas: the cover on the left says what Relay is, the gate on
 * the right holds the one thing this page asks for. Sign in, request access,
 * and redeem an invite all stand on it, so the brand moment is the same
 * whichever door a visitor came through — only the gate changes.
 */
export function AuthCanvas({ mode, children }: { mode: "login" | "waitlist" | "join"; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="login-screen" data-mode={mode}>
      {/* The double-chevron mark bled huge off the canvas edge — the login
          signature. Fixed so it can leave the viewport without creating
          scrollable overflow; washed from --lg-ink so it follows the theme. */}
      <span className="login-bleed" aria-hidden="true">
        <Chevrons />
      </span>

      {/* Left half: the cover. It says what Relay is; it holds no controls. */}
      <section className="login-cover">
        {/* The brand leads home: the landing page is the way back for a
            visitor who arrived at the gate before knowing what Relay is.
            The repository sits opposite it, as it does in the landing nav. */}
        <header className="login-cover-head">
          <PublicLink href="/" className="login-brand">
            <RelayMark size={ICON.xl} />
            <span className="login-wordmark">Relay</span>
          </PublicLink>
          <GithubLink className="login-github">
            <GithubMark size={ICON.md} />
            <span>{t("landing.github")}</span>
          </GithubLink>
        </header>

        <div className="login-intro">
          <h1 id="login-headline" className="login-headline">
            {t("login.cover_headline")}
          </h1>
          <p className="login-lede">{t("login.lede")}</p>
        </div>

        <ul className="login-points">
          {COVER_POINTS.map((key) => (
            <li className="login-point" key={key}>
              <Chevrons size={ICON.sm} className="login-point-mark" />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </section>

      {/* Right half: the gate. One column, one action. */}
      <section className="login-panel">
        <div className="login-panel-inner">{children}</div>
      </section>

      {/* A direct grid child, not a child of either half: on the split canvas
          it sits under the cover column, and on the stacked mobile layout it
          falls to the bottom of the page — one element, two placements, no
          duplicated markup. */}
      <footer className="login-foot">
        <span className="login-foot-meta">Relay · {new Date().getFullYear()}</span>
        <GithubLink className="login-foot-github" label={t("landing.github")}>
          <GithubMark size={ICON.md} />
        </GithubLink>
      </footer>
    </main>
  );
}
