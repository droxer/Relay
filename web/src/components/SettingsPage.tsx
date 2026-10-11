"use client";

import { useTranslation } from "react-i18next";
import { PageHeader } from "./PageHeader";
import { SectionNav, type SectionNavItem } from "./SectionNav";
import { hrefForSettingsSection } from "../lib/appRoute";
import { AppearanceSection, LanguageSection } from "./settings/PreferenceSections";
import {
  PrefAppearance,
  PrefLanguage,
} from "./icons";
import type { Language, Theme } from "../lib/appStorage";
import type { SettingsSection } from "../lib/viewTypes";

type SettingsPageProps = {
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
};

/**
 * Personal settings: how the app looks and speaks for one person. Their
 * computers and skills are destinations of their own in the sidenav's
 * Workforce group; what remains here is the preference lists. The
 * rail-and-content shape is the shared one (see section-rail.css), the same
 * the control panel uses for the org-level equivalents.
 */
export function SettingsPage({
  section,
  onSelectSection,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: SettingsPageProps) {
  const { t } = useTranslation();

  const items: SectionNavItem<SettingsSection>[] = [
    { id: "appearance", label: t("pref.appearance"), Icon: PrefAppearance, href: hrefForSettingsSection("appearance") },
    { id: "language", label: t("pref.language"), Icon: PrefLanguage, href: hrefForSettingsSection("language") },
  ];
  const sectionLabel = items.find((item) => item.id === section)?.label ?? t("nav.settings");

  return (
    <section
      id="settings-panel"
      className="settings-page sec-shell"
      data-settings-section={section}
      aria-label={t("nav.settings")}
      tabIndex={-1}
    >
      <div className="sec-rail">
        {/* Kicker + title, like every other list rail in the app — see the
            note on the control panel's rail. */}
        <PageHeader
          kicker={t("settings.eyebrow")}
          title={t("nav.settings")}
          titleAs="h2"
          titleVariant="title"
          layout="stacked"
        />
        <SectionNav
          items={items}
          value={section}
          onChange={onSelectSection}
          label={t("nav.settings")}
        />
      </div>

      <div className="sec-main">
        <PageHeader title={sectionLabel} titleAs="h2" titleVariant="title" />
        <div className="sec-section-body">
          {section === "appearance" ? (
            <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
          ) : (
            <LanguageSection language={language} onLanguageChange={onLanguageChange} />
          )}
        </div>
      </div>
    </section>
  );
}
