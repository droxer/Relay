import { useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { TagBadge } from "../TaskTags";
import { RelayApiError } from "../../api-client/client";
import { applyTagOperation, createTag, previewTagOperation, type TagOperation, type TagPreview } from "../../api-client/tags";
import { TAG_CATALOG_KEY, useTagCatalog } from "../../hooks/useTagCatalog";
import { filterTagEntries, tagErrorKey } from "../../lib/tagCatalog";

export function TagsSection() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const catalog = useTagCatalog();
  const [search, setSearch] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<{ name: string; kind: TagOperation["operation"] } | null>(null);
  const [target, setTarget] = useState("");
  const [preview, setPreview] = useState<{ operation: TagOperation; result: TagPreview } | null>(null);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState("");
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const createRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  function fail(reason: unknown) {
    setError(reason instanceof RelayApiError ? reason.code : "generic");
  }
  function close() {
    setEditing(null); setPreview(null); setError(undefined);
    requestAnimationFrame(() => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
      else searchRef.current?.focus();
    });
  }
  const create = useMutation({ mutationFn: (name: string) => createTag(name), onSuccess: async () => {
    setName(""); setSearch(""); setError(undefined); setNotice(t("tags.manager.created"));
    await client.invalidateQueries({ queryKey: TAG_CATALOG_KEY });
    createRef.current?.focus();
  }, onError: fail });
  const inspect = useMutation({ mutationFn: (operation: TagOperation) => previewTagOperation(operation), onSuccess: (result, operation) => {
    setPreview({ result, operation }); setError(undefined);
    requestAnimationFrame(() => editorRef.current?.focus());
  }, onError: fail });
  const apply = useMutation({ mutationFn: ({ operation, result }: NonNullable<typeof preview>) => applyTagOperation(operation, result.previewToken),
    onSuccess: async (result) => {
      // Replace the catalog immediately, then refresh every work projection.
      await client.cancelQueries({ queryKey: TAG_CATALOG_KEY });
      client.setQueryData(TAG_CATALOG_KEY, { tags: result.tags, total: result.tags.length });
      close(); setNotice(t("tags.manager.applied"));
      await Promise.all([["relay", "tasks"], ["tasks"], ["task-record"], ["task-events"]].map(queryKey => client.invalidateQueries({ queryKey })));
      if (!returnFocus.current?.isConnected) searchRef.current?.focus();
    }, onError: (reason) => { setPreview(null); fail(reason); } });
  const busy = create.isPending || inspect.isPending || apply.isPending;
  function operation(): TagOperation {
    if (editing!.kind === "delete") return { operation: "delete", name: editing!.name };
    if (editing!.kind === "merge") return { operation: "merge", sources: [editing!.name], target };
    return { operation: "rename", name: editing!.name, newName: target };
  }
  if (catalog.isPending) return <p role="status">{t("tags.manager.loading")}</p>;
  if (catalog.isError) return <div role="alert">{t("tags.manager.load_failed")} <Button variant="outline" onClick={() => void catalog.refetch()}>{t("tags.manager.retry")}</Button></div>;
  const entries = catalog.data.tags;
  const shown = filterTagEntries(entries, search);
  return <div className="tag-manager" aria-busy={busy}>
    <p className="tag-manager-hint">{t("tags.manager.intro")}</p>
    <form className="tag-manager-create" onSubmit={event => { event.preventDefault(); setError(undefined); setNotice(""); create.mutate(name); }}>
      <label htmlFor="tag-new-name">{t("tags.manager.new_name")}</label>
      <div className="tag-manager-controls">
        <Input ref={createRef} id="tag-new-name" value={name} disabled={busy || Boolean(editing)} onChange={event => setName(event.target.value)} placeholder={t("tags.manager.name_hint")} />
        <Button type="submit" disabled={busy || Boolean(editing) || !name.trim()}>{t("tags.manager.create")}</Button>
      </div>
    </form>
    <Input ref={searchRef} type="search" aria-label={t("tags.manager.search")} placeholder={t("tags.manager.search")} value={search} onChange={event => setSearch(event.target.value)} />
    <p className="tag-manager-notice" role="status">{notice}</p>
    {error && <div role="alert" className="tag-manager-error">
      <p>{t(tagErrorKey(error))}</p>
      {error === "tag_exists" && editing?.kind === "rename" && <Button variant="outline" disabled={busy} onClick={() => {
        setEditing({ ...editing, kind: "merge" }); setPreview(null); setError(undefined);
      }}>{t("tags.manager.offer_merge")}</Button>}
    </div>}
    {editing && <div className="tag-manager-editor" ref={editorRef} tabIndex={-1} role="group" aria-label={t(`tags.manager.${editing.kind}`)}>
      <h3>{t(`tags.manager.${editing.kind}`)} <TagBadge tag={editing.name} /></h3>
      <form onSubmit={event => { event.preventDefault(); setError(undefined); inspect.mutate(operation()); }}>
        {editing.kind !== "delete" && <div className="tag-manager-target">
          <label htmlFor="tag-target-name">{t("tags.manager.target_name")}</label>
          <Input id="tag-target-name" list="tag-merge-targets" value={target} disabled={busy || Boolean(preview)} onChange={event => { setTarget(event.target.value); setPreview(null); }} />
          <datalist id="tag-merge-targets">{entries.filter(entry => entry.name !== editing.name).map(entry => <option value={entry.name} key={entry.name} />)}</datalist>
        </div>}
        {editing.kind === "delete" && <p>{t("tags.manager.delete_hint")}</p>}
        {preview && <div className="tag-manager-impact">
          <p>{t("tags.manager.affected", { tasks: preview.result.affected.taskCount, automations: preview.result.affected.automationCount })}</p>
          <ul>{preview.result.affected.items.map(item => <li key={item.id}>{item.title}</li>)}</ul>
          {preview.result.affected.itemsTruncated && <p>{t("tags.manager.examples_limited")}</p>}
          {preview.result.excluded.taskCount + preview.result.excluded.automationCount > 0 && <>
            <p>{t("tags.manager.excluded", { tasks: preview.result.excluded.taskCount, automations: preview.result.excluded.automationCount })}</p>
            <ul>{preview.result.excluded.items.map(item => <li key={item.id}>{item.title} · <span>{t(`tags.manager.reasons.${item.reason}`)}</span></li>)}</ul>
            {preview.result.excluded.itemsTruncated && <p>{t("tags.manager.examples_limited")}</p>}
          </>}
        </div>}
        <div className="tag-manager-actions">
          {preview ? <Button type="button" variant={editing.kind === "delete" ? "destructive" : "default"} disabled={busy} onClick={() => apply.mutate(preview)}>{t("tags.manager.confirm")}</Button>
            : <Button type="submit" disabled={busy || (editing.kind !== "delete" && !target.trim())}>{t(busy ? "tags.manager.loading" : "tags.manager.preview")}</Button>}
          {preview && <Button type="button" variant="outline" disabled={busy} onClick={() => setPreview(null)}>{t("tags.manager.back")}</Button>}
          <Button type="button" variant="ghost" disabled={busy} onClick={close}>{t("tags.manager.cancel")}</Button>
        </div>
      </form>
    </div>}
    {!entries.length ? <p className="tag-manager-hint">{t("tags.manager.empty")}</p> : !shown.length ? <p className="tag-manager-hint">{t("tags.manager.no_results")}</p> : <ul className="tag-manager-list">
      {shown.map(entry => <li className="tag-manager-row" key={entry.name}>
        <div className="tag-manager-identity"><TagBadge tag={entry.name} />
          <span className="tag-manager-hint">{t("tags.manager.usage", { tasks: entry.taskCount, automations: entry.automationCount })}</span>
        </div>
        <div className="tag-manager-actions">{(["rename", "merge", "delete"] as const).map(kind => <Button key={kind} type="button" size="sm" variant="ghost" disabled={busy || Boolean(editing)} onClick={event => {
          returnFocus.current = event.currentTarget; setEditing({ name: entry.name, kind }); setTarget(kind === "rename" ? entry.name : ""); setPreview(null); setError(undefined); setNotice("");
          // The editor precedes the list, including when the list is scrolled.
          requestAnimationFrame(() => { editorRef.current?.focus(); editorRef.current?.scrollIntoView?.({ block: "nearest" }); });
        }}>{t(`tags.manager.${kind}`)}</Button>)}</div>
      </li>)}
    </ul>}
  </div>;
}
