"use client";

import { useMemo, type ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { useDndContext, type Announcements, type UniqueIdentifier } from "@dnd-kit/core";
import type { SortingStrategy } from "@dnd-kit/sortable";

import { Button } from "@/components/ui/button";
import { Pagination } from "@/components/ui/Pagination";
import {
  Kanban,
  KanbanBoard,
  KanbanColumn,
  KanbanColumnContent,
  KanbanItem,
  KanbanOverlay,
  type KanbanMoveEvent,
} from "@/components/reui/kanban";
import { ActionAdd, ICON } from "../icons";
import { BacklogTaskCard } from "./BacklogRecords";
import { TASK_FLOW_STAGES, type TaskWorkflowStage } from "../../lib/taskFlow";
import { laneForDropTarget, taskDropRejection } from "../../lib/taskDrag";
import type { Page } from "../../lib/pagination";
import type { RelayTaskListItem } from "../../types";

type CardProps = Omit<ComponentProps<typeof BacklogTaskCard>, keyof ComponentProps<"article">>;
type Lanes = Record<TaskWorkflowStage, RelayTaskListItem[]>;

/* Lane order is the board's status sort, not a hand-arranged queue: a drop
   changes a task's status and nothing else. So cards never make room for
   each other mid-drag — a shuffle would promise an order the drop can't keep. */
const NO_SHUFFLE: SortingStrategy = () => null;
// Lanes are the workflow itself and are never reordered (no
// KanbanColumnHandle is rendered), so the root's reorder callback is inert.
const IGNORE_LANE_REORDER = () => {};
const taskId = (task: RelayTaskListItem) => task.id;

interface BacklogBoardProps {
  lanes: Record<TaskWorkflowStage, Page<RelayTaskListItem>>;
  /** Every task in the lane across all pages, for the lane-head count. */
  laneTotals: Record<TaskWorkflowStage, number>;
  cardProps: (task: RelayTaskListItem) => CardProps;
  /** The single commit path; it owns the transition rules and refusals. */
  onMoveTask: (task: RelayTaskListItem, status: TaskWorkflowStage) => void;
  /** Omitted where nothing may be created (a read-only project). */
  onCreateInLane?: (status: TaskWorkflowStage) => void;
  onLanePageChange: (status: TaskWorkflowStage, page: number) => void;
}

export function BacklogBoard({ lanes, laneTotals, cardProps, onMoveTask, onCreateInLane, onLanePageChange }: BacklogBoardProps) {
  const { t } = useTranslation();
  const value = useMemo(
    () => Object.fromEntries(TASK_FLOW_STAGES.map((status) => [status, lanes[status].items])) as Lanes,
    [lanes],
  );
  const findTask = (id: UniqueIdentifier | null | undefined) => findIn(value, id);
  const laneLabel = (status: TaskWorkflowStage) => t(`backlog.statuses.${status}`);

  function commitMove({ event, overContainer }: KanbanMoveEvent) {
    const task = findTask(event.active.id);
    if (task) onMoveTask(task, overContainer as TaskWorkflowStage);
  }

  const titleOf = (id: UniqueIdentifier) => findTask(id)?.title ?? "";
  const laneOf = (id: UniqueIdentifier | undefined) => laneForDropTarget(id == null ? null : String(id), value);
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("backlog.drag_picked_up", { title: titleOf(active.id) }),
    onDragOver: ({ active, over }) => {
      const lane = laneOf(over?.id);
      return lane ? t("backlog.drag_over", { title: titleOf(active.id), status: laneLabel(lane) }) : undefined;
    },
    onDragEnd: ({ active, over }) => {
      const lane = laneOf(over?.id);
      return lane
        ? t("backlog.drag_dropped", { title: titleOf(active.id), status: laneLabel(lane) })
        : t("backlog.drag_cancelled", { title: titleOf(active.id) });
    },
    onDragCancel: ({ active }) => t("backlog.drag_cancelled", { title: titleOf(active.id) }),
  };

  return (
    <Kanban
      className="contents"
      value={value}
      onValueChange={IGNORE_LANE_REORDER}
      getItemValue={taskId}
      onMove={commitMove}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("backlog.drag_instructions") } }}
    >
      <BoardLanes
        value={value}
        lanes={lanes}
        laneTotals={laneTotals}
        cardProps={cardProps}
        onCreateInLane={onCreateInLane}
        onLanePageChange={onLanePageChange}
      />
      {/* The lifted card follows the pointer or finger; the original stays in
          its lane, ghosted, until the drop lands. */}
      <KanbanOverlay>
        {({ value: activeId }) => {
          const task = findTask(activeId);
          return task ? <BacklogTaskCard {...cardProps(task)} data-overlay="true" /> : null;
        }}
      </KanbanOverlay>
    </Kanban>
  );
}

type BoardLanesProps = Omit<BacklogBoardProps, "onMoveTask"> & { value: Lanes };

/**
 * The lanes, rendered inside the kanban's drag context so the dragged task and
 * the lane under it are read from dnd-kit directly rather than mirrored into
 * state. `over` is a lane (dropped on its empty space) or a card, which stands
 * for the lane that holds it.
 */
function BoardLanes({ value, lanes, laneTotals, cardProps, onCreateInLane, onLanePageChange }: BoardLanesProps) {
  const { t } = useTranslation();
  const { active, over } = useDndContext();
  const draggedTask = findIn(value, active?.id);
  const dropLane = laneForDropTarget(over ? String(over.id) : null, value);
  const laneLabel = (status: TaskWorkflowStage) => t(`backlog.statuses.${status}`);

  // Only the hovered lane is decorated; a task's own lane stays neutral so
  // hovering back over the origin does not read as an error.
  function laneDropState(status: TaskWorkflowStage): "active" | "blocked" | undefined {
    if (!draggedTask || dropLane !== status) return undefined;
    const rejection = taskDropRejection(draggedTask, status);
    if (!rejection) return "active";
    return rejection === "needs_assignment" ? "blocked" : undefined;
  }

  // Snap is suspended mid-drag (backlog.css) so dnd-kit's edge auto-scroll
  // is not re-snapped back to the current lane every frame.
  return (
    <KanbanBoard className="backlog-board" data-dragging={draggedTask ? "true" : undefined}>
      {TASK_FLOW_STAGES.map((status) => (
        <KanbanColumn
          key={status}
          value={status}
          render={<section />}
          className="backlog-lane"
          data-status={status}
          data-drop={laneDropState(status)}
          aria-label={laneLabel(status)}
        >
          <header className="backlog-lane-head">
            <span className="backlog-lane-label">{laneLabel(status)}</span>
            <span className="backlog-lane-count tnum">{laneTotals[status]}</span>
          </header>
          <KanbanColumnContent value={status} strategy={NO_SHUFFLE} className="backlog-task-list">
            {laneTotals[status] === 0 ? (
              <p className="backlog-empty">{t("backlog.empty_lane")}</p>
            ) : value[status].map((task) => (
              /* role stays "article": dnd-kit's default "button" would nest
                 the card's checkbox and title link inside a button. The
                 card keeps its tab stop and "sortable" role description. */
              <KanbanItem key={task.id} value={task.id} asHandle role="article" render={<BacklogTaskCard {...cardProps(task)} />} />
            ))}
            {onCreateInLane && (status === "backlog" || status === "assigned") ? (
              <Button variant="ghost" type="button" className="backlog-lane-add" onClick={() => onCreateInLane(status)}>
                <ActionAdd size={ICON.sm} />
                <span>{t("backlog.new_task")}</span>
              </Button>
            ) : null}
          </KanbanColumnContent>
          {/* Inside the lane, under its cards — the cursor belongs to this
              lane and nothing about it is true of the board. */}
          <Pagination
            compact
            className="backlog-lane-pager"
            page={lanes[status]}
            onPageChange={(next) => onLanePageChange(status, next)}
            label={laneLabel(status)}
          />
        </KanbanColumn>
      ))}
    </KanbanBoard>
  );
}

function findIn(lanes: Lanes, id: UniqueIdentifier | null | undefined): RelayTaskListItem | undefined {
  return id == null ? undefined : TASK_FLOW_STAGES.flatMap((status) => lanes[status]).find((task) => task.id === String(id));
}
