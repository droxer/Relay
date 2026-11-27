import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { navigateToAppPath } from "../../lib/appRoute";

/** Keep a failed computer query distinct from a genuinely empty inventory. */
export function ComputerOptionsFeedback({ isLoading, isError, isFetching, empty, retry }: {
  isLoading: boolean;
  isError: boolean;
  isFetching: boolean;
  empty: boolean;
  retry: () => void;
}) {
  const { t } = useTranslation();
  if (isLoading) return null;
  if (isError) return (
    <div className="flex flex-col items-start gap-2">
      <p className="adm-form-hint" role="alert">{t("computer.options_failed")}</p>
      <Button type="button" variant="outline" size="sm" onClick={retry} loading={isFetching}>
        {t("computer.options_retry")}
      </Button>
    </div>
  );
  if (!empty) return null;
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="adm-form-hint">{t("agents_page.create_computer_empty")}</p>
      <Button
        variant="outline"
        size="sm"
        nativeButton={false}
        render={
          <a
            href="/computers"
            onClick={(event) => {
              if (!event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) {
                event.preventDefault();
                void navigateToAppPath("/computers");
              }
            }}
          />
        }
      >
        {t("nav.computers")}
      </Button>
    </div>
  );
}
