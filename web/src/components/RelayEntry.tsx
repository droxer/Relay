"use client";

import { createElement, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuthSession } from "../hooks/useAuthSession";
import { useClientMounted } from "../hooks/useClientMounted";
import { APP_NAVIGATION_EVENT, isLandingPath } from "../lib/appRoute";
import { applyTheme, readLanguage, readSignedInHint, writeTheme, type Theme } from "../lib/appStorage";
import { AuthChecking } from "./AuthChecking";
import { LandingScreen } from "./landing/LandingScreen";

type AppComponent = typeof import("../App").App;

/* Not React.lazy: a Suspense boundary that has shown its fallback holds the
   content back for React's ~300ms reveal throttle, even when the chunk is
   already here. The entry keeps its own gate up instead and renders the app
   the moment the module resolves. */
let loadedApp: AppComponent | null = null;
let appRequest: Promise<AppComponent> | null = null;
function loadApp(): Promise<AppComponent> {
  appRequest ??= import("../App").then(
    (module) => (loadedApp = module.App),
    (error: unknown) => {
      // A failed chunk may load on the next attempt (a deploy in between).
      appRequest = null;
      throw error;
    },
  );
  return appRequest;
}

/** Whether the app's chunk has loaded; a load failure is thrown during
    render so the page's error boundary shows it. */
function useAppReady(needed: boolean): boolean {
  const [ready, setReady] = useState(() => loadedApp !== null);
  const [failure, setFailure] = useState<{ error: unknown } | null>(null);
  useEffect(() => {
    if (!needed || ready) return;
    let live = true;
    loadApp().then(
      () => { if (live) setReady(true); },
      (error: unknown) => { if (live) setFailure({ error }); },
    );
    return () => { live = false; };
  }, [needed, ready]);
  if (failure) throw failure.error;
  return ready;
}

/** Idle time after the landing page paints before the app's code is fetched. */
const APP_PREFETCH_FALLBACK_MS = 1_500;

/** A visitor at `/` who was not signed in last time gets the landing page on
    its own; everyone else needs the app. */
function opensOnLanding(): boolean {
  return isLandingPath(window.location.pathname) && !readSignedInHint();
}

// Fetch the app with the page's own code whenever it will be needed, instead
// of after hydration.
if (typeof window !== "undefined" && !opensOnLanding()) void loadApp().catch(() => undefined);

function changeTheme(theme: Theme) {
  applyTheme(theme);
  writeTheme(theme);
}

/** The landing page without the app behind it: the session probe and the
    saved language are all it needs. A signed-in answer hands over to the app,
    which sends the user on from `/`. */
function PublicLanding({ onNeedsApp }: { onNeedsApp: () => void }) {
  const { i18n } = useTranslation();
  const { user } = useAuthSession();

  useEffect(() => {
    if (user) onNeedsApp();
  }, [onNeedsApp, user]);

  // The saved language, applied the way the app's preferences hook does. The
  // tab title is LandingScreen's own, in whatever language this settles on.
  useEffect(() => {
    const language = readLanguage();
    document.documentElement.lang = language;
    if (i18n.language !== language) void i18n.changeLanguage(language);
  }, [i18n]);

  // Warm the app once the page is up, so "Sign in" opens without a wait.
  useEffect(() => {
    const prefetch = () => void loadApp().catch(() => undefined);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(prefetch, { timeout: APP_PREFETCH_FALLBACK_MS });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(prefetch, APP_PREFETCH_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return <LandingScreen onThemeChange={changeTheme} />;
}

/**
 * The page's root. Signed-out visitors at `/` see the landing page as soon as
 * the page's own code runs; the app — every signed-in surface — is a separate
 * chunk that loads alongside it for everyone else.
 */
export function RelayEntry() {
  const mounted = useClientMounted();
  const [needsApp, setNeedsApp] = useState(false);
  const handOver = useCallback(() => setNeedsApp(true), []);
  const showLanding = mounted && !needsApp && opensOnLanding();
  const appReady = useAppReady(mounted && !showLanding);

  // Leaving `/` (the landing page's "Sign in", or Back) needs the app.
  useEffect(() => {
    if (!mounted || needsApp) return;
    const sync = () => {
      if (!opensOnLanding()) setNeedsApp(true);
    };
    window.addEventListener(APP_NAVIGATION_EVENT, sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener(APP_NAVIGATION_EVENT, sync);
      window.removeEventListener("popstate", sync);
    };
  }, [mounted, needsApp]);

  if (showLanding) return <PublicLanding onNeedsApp={handOver} />;
  // The module's one App component, the same on every render.
  return appReady && loadedApp ? createElement(loadedApp) : <AuthChecking />;
}
