import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { cloneElement, createElement } from "react";

// jsdom ships no PointerEvent, but base-ui controls construct one from the
// owner window on click, so any test that clicks a <Checkbox>/<Switch> throws
// an unhandled "PointerEvent is not a constructor" without this shim.
if (!("PointerEvent" in globalThis)) {
  class PointerEventShim extends MouseEvent {}
  Object.assign(globalThis, { PointerEvent: PointerEventShim });
  if (typeof window !== "undefined") Object.assign(window, { PointerEvent: PointerEventShim });
}

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));
// Keep these tests focused on application lifecycles rather than portal animation.
vi.mock("@/components/ui/dialog", () => {
  const Box = ({ children, render: _render, initialFocus: _focus, ...props }: any) => createElement("div", props, children);
  return {
    Dialog: ({ open, children }: any) => open ? children : null,
    DialogPortal: Box, DialogBackdrop: Box, DialogViewport: Box,
    DialogContent: Box, DialogTitle: Box, DialogDescription: Box,
  };
});
vi.mock("@/components/ui/toast", () => ({ Toaster: () => null, toast: { add: vi.fn() } }));
vi.mock("@/components/ui/button", () => ({
  // `render` swaps the element like the real base-ui primitive does, so a
  // link-button (a download anchor) stays an anchor under test.
  // A string tooltip names the button, as the real primitive's aria-label
  // does — an explicit `aria-label` still wins.
  // `data-variant` mirrors the real Button, so a test can tell a filled
  // primary from one that stepped down.
  Button: ({ children, tooltip, variant = "default", size: _size, loading: _loading, loadingLabel: _loadingLabel, nativeButton: _native, render, ...rest }: any) => {
    const props = { "aria-label": typeof tooltip === "string" ? tooltip : undefined, "data-variant": variant, ...rest };
    return render ? cloneElement(render, props, children) : createElement("button", props, children);
  },
  // Real variants are class strings; tests only need a stable stand-in so
  // link-buttons stay distinguishable from bare anchors.
  buttonVariants: ({ variant = "default", size = "default" }: any = {}) => `btn-${variant} btn-${size}`,
}));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => createElement("input", props) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
