"use client";

// The app surfaces' styles ride this chunk; the global sheet holds only what
// the landing page and the auth gate paint before it (src/styles.css).
import "./styles/app.css";
// The rest of the English catalogue rides this chunk; registered before any
// signed-in surface renders (src/i18n/app.ts).
import "./i18n/app";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "./components/ui/DialogProvider";
import { TooltipProvider } from "./components/ui/tooltip";
import { ArtifactViewerProvider } from "./components/ArtifactViewerProvider";
import { BuildUpdateNotice } from "./components/BuildUpdateNotice";
import { LoginScreen } from "./components/LoginScreen";
import { WaitlistScreen } from "./components/waitlist/WaitlistScreen";
import { JoinScreen } from "./components/waitlist/JoinScreen";
import { ForgotPasswordScreen } from "./components/password-reset/ForgotPasswordScreen";
import { ResetPasswordScreen } from "./components/password-reset/ResetPasswordScreen";
import { LandingScreen } from "./components/landing/LandingScreen";
import { AuthChecking } from "./components/AuthChecking";
import { DeviceApproval } from "./components/computer/DeviceApproval";
import { AuthenticatedApp } from "./AuthenticatedApp";
import { applyTheme, normalizeLanguage, readTokens } from "./lib/appStorage";
import { isLandingPath, parseAppPath } from "./lib/appRoute";
import { useRelayStore } from "./lib/store";
import { useMutationError } from "./hooks/useMutationError";
import { useAuthSession } from "./hooks/useAuthSession";
import { useAuthRedirect } from "./hooks/useAuthRedirect";
import { useClientMounted } from "./hooks/useClientMounted";
import { useLocationPathname } from "./hooks/useLocationPathname";
import { useUserPreferences } from "./hooks/useUserPreferences";

const DEVICE_APPROVAL_PATHS = ["/computer", "/settings/computers"];
const DEVICE_CODE_PATTERN = /^[A-Za-z0-9_-]{32}$/;

function deviceApprovalCode(): string | null {
  const code = new URL(window.location.href).searchParams.get("connect");
  return DEVICE_APPROVAL_PATHS.includes(window.location.pathname) && code && DEVICE_CODE_PATTERN.test(code) ? code : null;
}

// ── App ───────────────────────────────────────────────────────────────────────

/**
 * The providers only a signed-in surface uses: dialogs and toasts, tooltips,
 * and the artifact viewer. They ride the app chunk, not the page's own code,
 * so a visitor on the landing page or the sign-in screen never loads them.
 */
export function SignedInProviders({ children }: { children: ReactNode }) {
  return (
    // One tooltip provider for the app, so the delay before the FIRST
    // tooltip opens is paid once and moving between neighbouring icon
    // buttons swaps the popup instead of re-waiting per control.
    <TooltipProvider>
      <DialogProvider>
        <BuildUpdateNotice />
        <ArtifactViewerProvider>{children}</ArtifactViewerProvider>
      </DialogProvider>
    </TooltipProvider>
  );
}

/**
 * The app: the auth gate under the providers every signed-in surface (and
 * the gate's own toasts) use. RelayEntry loads this module as its own chunk,
 * so the signed-in tree rides it rather than paying a second lazy hop (and
 * Suspense's reveal throttle).
 */
export function App() {
  return (
    <SignedInProviders>
      <AuthGate />
    </SignedInProviders>
  );
}

/**
 * The auth gate. Renders the landing, sign-in, waitlist, and invite screens
 * itself and hands a signed-in user to AuthenticatedApp.
 */
function AuthGate() {
  const { t, i18n } = useTranslation();
  const { reportMutationError } = useMutationError();
  const setSelectedUser = useRelayStore((s) => s.setSelectedUser);
  const setTokens = useRelayStore((s) => s.setTokens);
  const { user, authChecked, setUser } = useAuthSession();
  const mounted = useClientMounted();
  const pathname = useLocationPathname();
  const preferences = useUserPreferences({
    mounted,
    i18n,
    setUser,
    reportMutationError,
    saveErrorMessage: t("errors.save_preferences"),
  });
  const [preferencesUserId, setPreferencesUserId] = useState<string | null>(null);
  const [preferencesOwner, setPreferencesOwner] = useState(user?.id ?? null);
  if (preferencesOwner !== (user?.id ?? null)) {
    setPreferencesOwner(user?.id ?? null);
    setPreferencesUserId(null);
  }
  const userId = user?.id ?? null;
  // The id the thread views select by: the user's own id, else their login.
  const selectionId = user?.userId ?? user?.username ?? "";

  useAuthRedirect({ ready: mounted && authChecked, signedIn: Boolean(user), pathname });

  const { invalidate: invalidatePreferences, adopt: adoptPreferences } = preferences;
  useEffect(() => {
    invalidatePreferences(userId);
  }, [invalidatePreferences, userId]);

  useEffect(() => {
    if (!mounted) return;
    if (!user) return;
    if (preferencesUserId === user.id) return;

    const nextTheme = user.theme ?? "system";
    const nextLanguage = normalizeLanguage(user.language);
    adoptPreferences({ theme: nextTheme, language: nextLanguage });
    applyTheme(nextTheme);
    document.documentElement.lang = nextLanguage;
    const languageChange = i18n.language === nextLanguage
      ? Promise.resolve()
      : i18n.changeLanguage(nextLanguage);
    let cancelled = false;
    void languageChange
      .catch((error: unknown) => console.error("[relay] language change failed", error))
      .finally(() => { if (!cancelled) setPreferencesUserId(user.id); });
    return () => { cancelled = true; };
  }, [adoptPreferences, i18n, mounted, preferencesUserId, user]);

  // Keyed on the id, not the user object: an auth refetch hands back a new
  // object for the same person, and re-reading storage for it was waste.
  useEffect(() => {
    if (!authChecked) return;
    setTokens(readTokens());
    // The logged-in user's threads are the sessions they own. Pin the
    // selection to self so the chat view always shows the current user's own
    // work (never another user's).
    if (selectionId) setSelectedUser(selectionId);
  }, [authChecked, selectionId, setTokens, setSelectedUser]);

  if (!mounted || !authChecked || (user && preferencesUserId !== user.id)) {
    return <AuthChecking />;
  }

  if (!user) {
    if (isLandingPath(window.location.pathname)) return <LandingScreen onThemeChange={preferences.setTheme} />;
    const { publicPage } = parseAppPath(window.location.pathname);
    if (publicPage === "waitlist") return <WaitlistScreen />;
    if (publicPage === "join") return <JoinScreen onAuthenticated={(authenticatedUser) => setUser(authenticatedUser)} />;
    if (publicPage === "forgot-password") return <ForgotPasswordScreen />;
    if (publicPage === "reset-password") return <ResetPasswordScreen />;
    return <LoginScreen onAuthenticated={(authenticatedUser) => setUser(authenticatedUser)} />;
  }

  const deviceCode = deviceApprovalCode();
  if (deviceCode) return <DeviceApproval code={deviceCode} />;
  return <AuthenticatedApp user={user} setUser={setUser} preferences={preferences} />;
}
