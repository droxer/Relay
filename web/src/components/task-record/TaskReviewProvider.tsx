"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { Dialog, DialogBackdrop, DialogContent, DialogPortal, DialogTitle, DialogViewport } from "../ui/dialog";
import { TaskReviewPanel } from "./TaskReviewPanel";

const TaskReviewContext = createContext<(taskId: string) => void>(() => {
  throw new Error("Task acceptance must be used within <TaskReviewProvider>");
});

export function useTaskReview() {
  return useContext(TaskReviewContext);
}

/** Status menus and board drops ask for a decision against the same evidence
 * as the record. Selecting Done never writes a status on its own. */
export function TaskReviewProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const [taskId, setTaskId] = useState<string | null>(null);
  const openReview = useCallback((id: string) => setTaskId(id), []);
  const closeReview = () => setTaskId(null);
  return (
    <TaskReviewContext.Provider value={openReview}>
      {children}
      <Dialog open={taskId !== null} onOpenChange={(open) => { if (!open) closeReview(); }}>
        {taskId ? <DialogPortal>
          <DialogBackdrop className="dialog-backdrop" />
          <DialogViewport className="dialog-viewport">
            <DialogContent className="dialog-modal task-review-dialog" aria-describedby={undefined}>
              <DialogTitle className="dialog-title">{t("task_review.title")}</DialogTitle>
              <TaskReviewPanel key={taskId} taskId={taskId} onAccepted={closeReview} />
              <div className="dialog-actions">
                <Button type="button" variant="ghost" onClick={closeReview}>{t("dialog.cancel")}</Button>
              </div>
            </DialogContent>
          </DialogViewport>
        </DialogPortal> : null}
      </Dialog>
    </TaskReviewContext.Provider>
  );
}
