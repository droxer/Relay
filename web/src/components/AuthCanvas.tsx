"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RelayMark } from "./RelayMark";
import { ICON } from "./icons";
import { GithubLink, GithubMark } from "./landing/GithubMark";
import { PublicLink } from "./waitlist/PublicLink";

/* Three things you do with Relay, in the order the landing page tells them:
   assign the work, watch it run, decide what ships. The cover repeats the
   landing headline, so a visitor who came through either door meets one
   product. Verbs, not product tiers. */
const COVER_POINTS = ["login.do_assign", "login.do_watch", "login.do_control"] as const;

/**
 * The signed-out canvas: the cover on the left says what Relay is, the gate on
 * the right holds the one thing this page asks for. Sign in, request access,
 * and redeem an invite all stand on it, so the brand moment is the same
 * whichever door a visitor came through — only the gate changes.
 */
export function AuthCanvas({ mode, children }: { mode: "login" | "waitlist" | "join" | "forgot-password" | "reset-password"; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <main className="login-screen" data-mode={mode}>
      {/* Left half: the cover. It says what Relay is; it holds no controls. */}
      <section className="login-cover">
        {/* The brand leads home: the landing page is the way back for a
            visitor who arrived at the gate before knowing what Relay is.
            The repository sits opposite it, as it does in the landing nav. */}
        <header className="login-cover-head">
          <PublicLink href="/" className="login-brand">
            <RelayMark size={ICON.xl} tone="brand" />
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
              {t(key)}
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
        <span className="login-foot-meta">© {new Date().getFullYear()} Relay</span>
        <GithubLink className="login-foot-github" label={t("landing.github")}>
          <GithubMark size={ICON.md} />
        </GithubLink>
      </footer>
    </main>
  );
}
