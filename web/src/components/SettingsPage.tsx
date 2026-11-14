"use client";

import { useTranslation } from "react-i18next";
import { PageHeader } from "./PageHeader";
import { SectionNav, type SectionNavItem } from "./SectionNav";
import { hrefForSettingsSection } from "../lib/appRoute";
import { AppearanceSection, LanguageSection } from "./settings/PreferenceSections";
import type { CurrentUser } from "../types";
import { TagsSection } from "./settings/TagsSection";
import { AccountSection } from "./settings/AccountSection";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import {
  IdentityUser,
  AdminConnect,
  NavNotifications,
  PrefAppearance,
  PrefLanguage,
  PrefTags,
} from "./icons";
import type { Language, Theme } from "../lib/appStorage";
import type { SettingsSection } from "../lib/viewTypes";

type SettingsPageProps = {
  user: CurrentUser;
  onUserChange: (user: CurrentUser) => void;
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
};

/**
 * Personal settings: what the app tells a person about, and how it looks and
 * speaks. The rail-and-content shape is the shared one (see section-rail.css),
 * the same the control panel uses for the org-level equivalents. Each section
 * is a plain option list, so the column gives it a header and a scrolling
 * body. Computers and Skills used to be sections here; they are Infra pages
 * of their own now (`/computers`, `/skills`).
 */
export function SettingsPage({
  user,
  onUserChange,
  section,
  onSelectSection,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: SettingsPageProps) {
  const { t } = useTranslation();

  const items: SectionNavItem<SettingsSection>[] = [
    { id: "account", label: t("account.title"), Icon: IdentityUser, href: hrefForSettingsSection("account") },
    { id: "connections", label: t("connections.title"), Icon: AdminConnect, href: hrefForSettingsSection("connections") },
    { id: "notifications", label: t("notifications.title"), Icon: NavNotifications, href: hrefForSettingsSection("notifications") },
    { id: "tags", label: t("tags.manager.title"), Icon: PrefTags, href: hrefForSettingsSection("tags") },
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
        {/* Title alone, like every other list rail in the app — see the
            note on the control panel's rail. */}
        <PageHeader
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
          {section === "account" ? (
            <AccountSection key={user.id} user={user} onUserChange={onUserChange} />
          ) : section === "connections" ? (
            <ConnectionsSection />
          ) : section === "notifications" ? (
            <NotificationsSection />
          ) : section === "tags" ? (
            <TagsSection />
          ) : section === "appearance" ? (
            <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
          ) : (
            <LanguageSection language={language} onLanguageChange={onLanguageChange} />
          )}
        </div>
      </div>
    </section>
  );
}
