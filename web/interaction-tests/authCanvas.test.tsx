import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import en from "../src/i18n/locales/en/translation.json";
import { AuthCanvas } from "../src/components/AuthCanvas";

type Messages = { [key: string]: Messages | string };

vi.mock("react-i18next", () => ({ useTranslation: () => ({
  t: (key: string) => {
    const found = key.split(".").reduce<Messages | string | undefined>(
      (value, part) => (typeof value === "object" ? value[part] : undefined),
      en as Messages,
    );
    return typeof found === "string" ? found : key;
  },
  i18n: { language: "en" },
}) }));

it("links to the open-source repository from the cover head and the foot, as the landing page does", () => {
  render(<AuthCanvas mode="login"><p>gate</p></AuthCanvas>);
  const links = screen.getAllByRole("link", { name: en.landing.github });
  expect(links.length).toBe(2);
  for (const link of links) {
    expect(link.getAttribute("href")).toBe("https://github.com/droxer/Relay");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
  }
});
