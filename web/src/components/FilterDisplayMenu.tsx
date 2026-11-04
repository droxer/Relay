"use client";

import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ActionDisplayOptions, ICON } from "./icons";

/** A list's arrangement — its group and sort menus — behind one glyph. On a
 *  phone those menus took a toolbar row of their own under search and Add
 *  filter; folded here, the toolbar is one row and the list starts higher.
 *  The menus themselves are the page's, rendered unchanged inside. */
export function FilterDisplayMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button type="button" variant="outline" size="icon" className="backlog-display-trigger" aria-label={t("filters.display")}>
            <ActionDisplayOptions size={ICON.md} aria-hidden="true" />
          </Button>
        }
      />
      <PopoverContent align="end" className="backlog-display-panel" aria-label={t("filters.display")}>
        {children}
      </PopoverContent>
    </Popover>
  );
}
