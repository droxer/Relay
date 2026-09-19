"use client";

import { useTranslation } from "react-i18next";
import { ComputerPage } from "./ComputerPage";
import { SkillsPage } from "./SkillsPage";
import { PageHeader } from "./PageHeader";
import { SectionNav, type SectionNavItem } from "./SectionNav";
import { AppearanceSection, LanguageSection } from "./settings/PreferenceSections";
import {
  NavComputer,
  NavSkills,
  PrefAppearance,
  PrefLanguage,
} from "./icons";
import type { Language, Theme } from "../lib/appStorage";
import type { SettingsSection } from "../lib/viewTypes";
import type { CurrentUser, DaemonNodeMonitorRecord } from "../types";

export type SettingsPageProps = {
  section: SettingsSection;
  onSelectSection: (section: SettingsSection) => void;
  currentUser: CurrentUser;
  nodes: DaemonNodeMonitorRecord[];
  onOpenThread?: (sessionId: string) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
};

/**
 * Personal settings: one destination holding the sections a person owns for
 * themselves — their computers, the skills they publish, and how the app
 * looks and speaks. The rail-and-content shape is the shared one (see
 * section-rail.css), the same the control panel uses for the org-level
 * equivalents.
 *
 * Computers and Skills bring their own page frame (a roster with its own
 * header, a library with its own rail), so they fill the content column
 * whole; appearance and language are plain option lists, so the column gives
 * them its own header and a scrolling body.
 */
export function SettingsPage({
  section,
  onSelectSection,
  currentUser,
  nodes,
  onOpenThread,
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: SettingsPageProps) {
  const { t } = useTranslation();

  const items: SectionNavItem<SettingsSection>[] = [
    { id: "computers", label: t("computer.title"), Icon: NavComputer },
    { id: "skills", label: t("skills.title"), Icon: NavSkills },
    { id: "appearance", label: t("pref.appearance"), Icon: PrefAppearance },
    { id: "language", label: t("pref.language"), Icon: PrefLanguage },
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
        <PageHeader
          kicker={t("settings.eyebrow")}
          title={t("nav.settings")}
          subtitle={t("settings.sub")}
          titleVariant="display"
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
        {section === "computers" ? (
          <ComputerPage nodes={nodes} currentUser={currentUser} onOpenThread={onOpenThread} />
        ) : section === "skills" ? (
          <SkillsPage currentUser={currentUser} />
        ) : (
          <>
            <PageHeader title={sectionLabel} titleAs="h2" titleVariant="display" />
            <div className="sec-section-body">
              {section === "appearance" ? (
                <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
              ) : (
                <LanguageSection language={language} onLanguageChange={onLanguageChange} />
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
