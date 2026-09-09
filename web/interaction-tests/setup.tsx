import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";
import { createElement } from "react";

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
vi.mock("@/components/ui/button", () => ({ Button: ({ children, tooltip: _tooltip, variant: _variant, size: _size, loading: _loading, loadingLabel: _loadingLabel, ...props }: any) => createElement("button", props, children) }));
vi.mock("@/components/ui/input", () => ({ Input: (props: any) => createElement("input", props) }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); });
