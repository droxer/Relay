import { useTranslation } from "react-i18next";
import { BreadcrumbSeparator, ICON } from "./icons";

export type BreadcrumbItem = {
  label: string;
  /** A level with somewhere to go; omit it for a level that is only a location. */
  onSelect?: () => void;
};

/**
 * The ancestors of a page title, each followed by a chevron. The title itself
 * is not a crumb — PageHeader renders it as the heading right after the trail,
 * so the current level is named once, in the heading's own type.
 */
export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) return null;
  return (
    <nav className="breadcrumb" aria-label={t("nav.breadcrumb")}>
      <ol className="breadcrumb-list">
        {items.map((item, index) => (
          <li key={`${index}-${item.label}`} className="breadcrumb-item">
            {item.onSelect ? (
              <button type="button" className="breadcrumb-link" onClick={item.onSelect}>
                {item.label}
              </button>
            ) : (
              <span>{item.label}</span>
            )}
            <BreadcrumbSeparator className="breadcrumb-separator" size={ICON.sm} aria-hidden="true" />
          </li>
        ))}
      </ol>
    </nav>
  );
}
