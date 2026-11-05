import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadImageAttachment } from "relay-core";
import { uploadThreadImage } from "../../api-client/sessions";
import { Tooltip } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { StreamAttachment, ICON } from "../icons";

export function useComposerImages(draftKey?: string) {
  const [imageDraftKey, setImageDraftKey] = useState(draftKey);
  const [images, setImages] = useState<Array<ThreadImageAttachment & { preview: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploads = useRef({ generation: 0, previews: new Set<string>(), controller: null as AbortController | null });
  const { t } = useTranslation();
  // Reset before the new Thread commits, so its composer cannot show or send
  // the previous Thread's images. The effect only releases external resources.
  if (imageDraftKey !== draftKey) {
    setImageDraftKey(draftKey);
    setImages([]);
    setBusy(false);
    setError(null);
  }
  const clear = () => {
    const resources = uploads.current;
    resources.generation++;
    resources.controller?.abort();
    resources.controller = null;
    for (const url of resources.previews) URL.revokeObjectURL(url);
    resources.previews.clear();
    setImages([]);
    setBusy(false);
    setError(null);
  };
  useEffect(() => {
    const resources = uploads.current;
    return () => {
      resources.generation++;
      resources.controller?.abort();
      resources.controller = null;
      for (const url of resources.previews) URL.revokeObjectURL(url);
      resources.previews.clear();
    };
  }, [draftKey]); // The image draft belongs to the same Thread as the text draft.

  async function add(files: File[]) {
    const resources = uploads.current;
    if (resources.controller || !files.length) return;
    setError(null);
    if (images.length + files.length > 4 || files.some(file => file.size < 1 || file.size > 10 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      setError(t("composer.image_limits", { defaultValue: "Choose up to 4 PNG, JPEG, or WebP images, at most 10 MB each." }));
      return;
    }
    const current = resources.generation;
    const abort = new AbortController();
    resources.controller = abort;
    setBusy(true);
    try {
      for (const file of files) {
        const attachment = await uploadThreadImage(file, abort.signal);
        if (resources.generation !== current) return;
        const preview = URL.createObjectURL(file);
        resources.previews.add(preview);
        setImages(previous => [...previous, { ...attachment, preview }]);
      }
    } catch (cause) {
      if (resources.generation === current) setError(cause instanceof Error ? cause.message : t("composer.image_failed", { defaultValue: "Image upload failed. Choose the image to try again." }));
    } finally {
      if (resources.generation === current) { resources.controller = null; setBusy(false); }
    }
  }
  return { images, busy, error, add, clear, remove(id: string) {
    const image = images.find(image => image.id === id);
    if (image) { URL.revokeObjectURL(image.preview); uploads.current.previews.delete(image.preview); }
    setImages(previous => previous.filter(image => image.id !== id));
  } };
}

export function ComposerImagePicker({ input, disabled, unavailableReason }: {
  input: ReturnType<typeof useComposerImages>;
  disabled: boolean;
  unavailableReason?: string;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const reasonId = useId();
  const { t } = useTranslation();
  const label = t("composer.attach_image", { defaultValue: "Attach images" });
  const blocked = disabled || !!unavailableReason || input.busy || input.images.length >= 4;
  const button = <Button type="button" variant="ghost" size="icon" disabled={blocked}
    aria-label={label} tooltip={unavailableReason ? undefined : label}
    onClick={() => fileInput.current?.click()}><StreamAttachment size={ICON.sm} /></Button>;
  return <>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={blocked} onChange={event => {
      if (!blocked) void input.add(Array.from(event.target.files ?? []));
      event.target.value = "";
    }} />
    {unavailableReason ? <>
      {/* Disabled buttons cannot receive pointer/focus events; the wrapper
          keeps the update explanation reachable by mouse and keyboard. */}
      <Tooltip content={unavailableReason}>
        <span className="inline-flex" role="group" tabIndex={0} aria-label={label} aria-describedby={reasonId}>
          {button}
        </span>
      </Tooltip>
      <span id={reasonId} className="sr-only">{unavailableReason}</span>
    </> : button}
  </>;
}

export function ComposerImagePreviews({ input }: { input: ReturnType<typeof useComposerImages> }) {
  const { t } = useTranslation();
  return <>
    {input.images.length > 0 && <div className="composer-images">
      {input.images.map((image, index) => <div className="composer-image" key={image.id}>
        <img src={image.preview} alt={t("composer.image_number", { defaultValue: "Attached image {{number}}", number: index + 1 })} />
        <Button type="button" variant="secondary" size="sm" onClick={() => input.remove(image.id)}
          aria-label={t("composer.remove_image", { defaultValue: "Remove image {{number}}", number: index + 1 })}>
          {t("composer.remove_image_button", { defaultValue: "Remove" })}
        </Button>
      </div>)}
    </div>}
    {input.busy && <p className="composer-image-status" role="status">{t("composer.uploading_images", { defaultValue: "Uploading images…" })}</p>}
    {input.error && <p className="composer-image-status" role="alert">{input.error}</p>}
  </>;
}
