import { render, screen } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import { LandingScreen } from "../src/components/landing/LandingScreen";
import { useWaitlistEnabled } from "../src/hooks/useAuthStatus";

vi.mock("../src/hooks/useAuthStatus", () => ({ useWaitlistEnabled: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => key.split(".").reduce<any>((value, part) => value?.[part], en) ?? key,
  i18n: { language: "en" },
}) }));

beforeEach(() => {
  vi.mocked(useWaitlistEnabled).mockReset();
  document.documentElement.setAttribute("data-theme", "dark");
});
afterEach(() => { document.documentElement.removeAttribute("data-theme"); });

it("says what Relay is and shows the real product", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(null);
  render(<LandingScreen />);
  expect(screen.getByRole("heading", { level: 1, name: en.landing.headline })).toBeTruthy();
  const hero = screen.getByRole("img", { name: en.landing.hero_alt }) as HTMLImageElement;
  expect(hero.getAttribute("src")).toBe("/landing/threads.webp");
  expect(screen.getByRole("heading", { name: en.landing.how_title })).toBeTruthy();
  expect(screen.getByRole("heading", { name: en.landing.tour_automations_title })).toBeTruthy();
});

it("titles the tab with what Relay does, and hands it back on leaving", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(null);
  const { unmount } = render(<LandingScreen />);
  expect(document.title).toBe(en.landing.page_title);
  unmount();
  expect(document.title).toBe(en.app.title);
});

it("leads with request access while the waitlist takes requests", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(true);
  render(<LandingScreen />);
  const requests = screen.getAllByRole("link", { name: en.landing.request_access });
  expect(requests.length).toBeGreaterThan(0);
  for (const link of requests) expect(link.getAttribute("href")).toBe("/waitlist");
  expect(screen.getAllByRole("link", { name: en.landing.sign_in })[0].getAttribute("href")).toBe("/login");
});

it("never links to a closed waitlist", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(false);
  render(<LandingScreen />);
  expect(screen.queryByRole("link", { name: en.landing.request_access })).toBeNull();
  expect(screen.getAllByRole("link", { name: en.landing.sign_in })[0].getAttribute("href")).toBe("/login");
});

it("links to the open-source repository from the bar, its own section, and the foot", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(null);
  render(<LandingScreen />);
  const links = screen.getAllByRole("link").filter((link) => link.getAttribute("href") === "https://github.com/droxer/Relay");
  expect(links.length).toBe(3);
  for (const link of links) {
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
  expect(screen.getByRole("heading", { name: en.landing.oss_title })).toBeTruthy();
  expect(screen.getByText("git clone https://github.com/droxer/Relay.git")).toBeTruthy();
});

it("shows the screenshots cut for the active theme", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(null);
  document.documentElement.setAttribute("data-theme", "light");
  render(<LandingScreen />);
  const hero = screen.getByRole("img", { name: en.landing.hero_alt });
  expect(hero.getAttribute("src")).toBe("/landing/threads-light.webp");
});

it("flips the theme from the bar", () => {
  vi.mocked(useWaitlistEnabled).mockReturnValue(null);
  const onThemeChange = vi.fn();
  render(<LandingScreen onThemeChange={onThemeChange} />);
  fireEvent.click(screen.getByRole("button", { name: en.landing.theme_to_light }));
  expect(onThemeChange).toHaveBeenCalledWith("light");
});
