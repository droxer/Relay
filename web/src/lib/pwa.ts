/** Installability and a generic offline fallback, independent of auth state. */
export async function registerPwaServiceWorker(enabled = process.env.NODE_ENV === "production"): Promise<void> {
  if (!enabled || typeof window === "undefined" || !window.isSecureContext || !("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
  } catch (error) {
    // Private browsing, policy, or a failed request must not block the app.
    console.warn("[relay] service worker registration failed", error);
  }
}
