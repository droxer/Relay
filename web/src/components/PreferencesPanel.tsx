"use client";

import { useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_THEMES,
  type Language,
  type Theme,
} from "../lib/appStorage";
import {
  ICON,
  PrefAppearance,
  PrefLanguage,
} from "./icons";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type { Language, Theme };
export { SUPPORTED_LANGUAGES, SUPPORTED_THEMES };

const LANGUAGES: { code: Language; label: string; native: string }[] = [
  { code: "en",    label: "English",            native: "English"   },
  { code: "zh-CN", label: "Simplified Chinese", native: "简体中文"   },
  { code: "zh-TW", label: "Traditional Chinese",native: "繁體中文"   },
];

const THEME_VALUES: Theme[] = ["light", "dark", "system"];

/* Settings categories. Adding a new settings area = one entry here plus a
   case in renderSection (and its `pref.<id>` i18n label). The left nav and
   the content panel are both driven by this list. */
type CategoryId = "appearance" | "language";

type IconComponent = ComponentType<{ size?: number }>;

const CATEGORIES: { id: CategoryId; labelKey: string; Icon: IconComponent }[] = [
  { id: "appearance", labelKey: "pref.appearance", Icon: PrefAppearance },
  { id: "language", labelKey: "pref.language", Icon: PrefLanguage },
];

const LANGUAGE_BADGES: Record<Language, string> = {
  en: "EN",
  "zh-CN": "简",
  "zh-TW": "繁",
};

/* Bespoke rather than an icons.tsx export, deliberately: this is a filled disc
   with a knockout check in --action/--on-action, which says "you picked this".
   The nearest export, StatusOk, is an outlined circle-check that says "this is
   healthy". Same rough silhouette, different sentence — reusing it would make a
   selected radio and a green status the same picture. */
function PrefSelectedCheck() {
  return (
    <span className="pref-option-check" aria-hidden="true">
      <svg width="12" height="12" viewBox="0 0 14 14" fill="none">
        <circle cx="7" cy="7" r="7" fill="var(--action)" />
        <path d="M4 7l2 2 4-4" stroke="var(--on-action)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

function ThemeSwatch({ tone }: { tone: Theme }) {
  return <span className="pref-theme-swatch" data-tone={tone} aria-hidden="true" />;
}

function LanguageBadge({ code }: { code: Language }) {
  return (
    <Badge className="pref-lang-badge" lang={code} aria-hidden="true">
      {LANGUAGE_BADGES[code]}
    </Badge>
  );
}

function ThemeOption({ value, selected }: { value: Theme; selected: boolean }) {
  const { t } = useTranslation();
  return (
    <RadioGroupChoice
      value={value}
      className={`pref-option-row ${selected ? "selected" : ""}`}
    >
      <ThemeSwatch tone={value} />
      <span className="pref-option-copy">
        <span className="pref-option-label">{t(`pref.theme.${value}`)}</span>
        <span className="pref-option-sub">{t(`pref.theme.${value}_sub`)}</span>
      </span>
      {selected ? <PrefSelectedCheck /> : null}
    </RadioGroupChoice>
  );
}

function AppearanceSection({
  theme,
  onThemeChange,
}: {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}) {
  const { t } = useTranslation();
  return (
    <fieldset className="pref-fieldset">
      <legend className="pref-group-label">{t("pref.theme.group")}</legend>
      <RadioGroup
        className="pref-option-list"
        value={theme}
        onValueChange={(value) => onThemeChange(value as Theme)}
      >
        {THEME_VALUES.map((value) => (
          <ThemeOption key={value} value={value} selected={theme === value} />
        ))}
      </RadioGroup>
    </fieldset>
  );
}

function LanguageOption({
  code,
  label,
  native,
  selected,
}: {
  code: Language;
  label: string;
  native: string;
  selected: boolean;
}) {
  const showSub = native !== label;
  return (
    <RadioGroupChoice
      value={code}
      className={`pref-option-row ${selected ? "selected" : ""}`}
      lang={code}
    >
      <LanguageBadge code={code} />
      <span className="pref-option-copy">
        <span className="pref-option-label">{native}</span>
        {showSub ? <span className="pref-option-sub">{label}</span> : null}
      </span>
      {selected ? <PrefSelectedCheck /> : null}
    </RadioGroupChoice>
  );
}

function LanguageSection({
  language,
  onLanguageChange,
}: {
  language: Language;
  onLanguageChange: (language: Language) => void;
}) {
  const { t } = useTranslation();
  return (
    <RadioGroup
      className="pref-option-list"
      aria-label={t("pref.language")}
      value={language}
      onValueChange={(value) => onLanguageChange(value as Language)}
    >
      {LANGUAGES.map(({ code, label, native }) => (
        <LanguageOption
          key={code}
          code={code}
          label={label}
          native={native}
          selected={language === code}
        />
      ))}
    </RadioGroup>
  );
}

export interface PreferencesPanelProps {
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  language: Language;
  onLanguageChange: (language: Language) => void;
}

export function PreferencesPanel({
  theme,
  onThemeChange,
  language,
  onLanguageChange,
}: PreferencesPanelProps) {
  const { t } = useTranslation();
  const [active, setActive] = useState<CategoryId>("appearance");

  return (
    <Tabs
      className="pref-body"
      orientation="vertical"
      value={active}
      onValueChange={(value) => setActive(value as CategoryId)}
    >
      <TabsList className="pref-nav" render={<nav />} aria-label={t("pref.title")}>
        {CATEGORIES.map(({ id, labelKey, Icon }) => (
          <TabsTrigger
            key={id}
            value={id}
            className={`pref-nav-item ${active === id ? "active" : ""}`}
            data-modal-initial-focus={active === id ? "" : undefined}
          >
            <Icon size={ICON.sm} />
            <span className="pref-nav-label">{t(labelKey)}</span>
          </TabsTrigger>
        ))}
      </TabsList>

      <div className="pref-content">
        <TabsContent value="appearance">
          <AppearanceSection theme={theme} onThemeChange={onThemeChange} />
        </TabsContent>
        <TabsContent value="language">
          <LanguageSection
            language={language}
            onLanguageChange={onLanguageChange}
          />
        </TabsContent>
      </div>
    </Tabs>
  );
}
