import { taskRef, type TaskRefSource } from "../../lib/taskRef";

/** A task's ref as a way into its record: a real href, so it can be opened in
 * a new tab or copied; a plain click opens the record in place. The stored id
 * stays one hover away for anyone who needs the key itself. */
export function TaskRefLink({ task, href, onOpen }: { task: TaskRefSource; href: string; onOpen: () => void }) {
  return (
    <a
      className="task-ref-link"
      href={href}
      title={task.id}
      translate="no"
      onClick={(event) => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        onOpen();
      }}
    >{taskRef(task)}</a>
  );
}
