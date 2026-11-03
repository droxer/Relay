import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadImageAttachment } from "relay-core";
import { uploadThreadImage } from "../../api-client/sessions";
import { Button } from "@/components/ui/button";
import { StreamAttachment, ICON } from "../icons";

export function useComposerImages(draftKey?: string) {
  const [images, setImages] = useState<Array<ThreadImageAttachment & { preview: string }>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const previews = useRef(new Set<string>());
  const controller = useRef<AbortController | null>(null);
  const { t } = useTranslation();
  const clear = () => {
    generation.current++;
    controller.current?.abort();
    controller.current = null;
    for (const url of previews.current) URL.revokeObjectURL(url);
    previews.current.clear();
    setImages([]);
    setBusy(false);
    setError(null);
  };
  useEffect(() => {
    clear();
    return () => {
      generation.current++;
      controller.current?.abort();
      for (const url of previews.current) URL.revokeObjectURL(url);
      previews.current.clear();
    };
  }, [draftKey]); // The image draft belongs to the same Thread as the text draft.

  async function add(files: File[]) {
    if (controller.current || !files.length) return;
    setError(null);
    if (images.length + files.length > 4 || files.some(file => file.size < 1 || file.size > 10 * 1024 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type))) {
      setError(t("composer.image_limits", { defaultValue: "Choose up to 4 PNG, JPEG, or WebP images, at most 10 MB each." }));
      return;
    }
    const current = generation.current;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      for (const file of files) {
        const attachment = await uploadThreadImage(file, abort.signal);
        if (generation.current !== current) return;
        const preview = URL.createObjectURL(file);
        previews.current.add(preview);
        setImages(previous => [...previous, { ...attachment, preview }]);
      }
    } catch (cause) {
      if (generation.current === current) setError(cause instanceof Error ? cause.message : t("composer.image_failed", { defaultValue: "Image upload failed. Choose the image to try again." }));
    } finally {
      if (generation.current === current) { controller.current = null; setBusy(false); }
    }
  }
  return { images, busy, error, add, clear, remove(id: string) {
    const image = images.find(image => image.id === id);
    if (image) { URL.revokeObjectURL(image.preview); previews.current.delete(image.preview); }
    setImages(previous => previous.filter(image => image.id !== id));
  } };
}

export function ComposerImagePicker({ input, disabled }: { input: ReturnType<typeof useComposerImages>; disabled: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const { t } = useTranslation();
  return <>
    <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden disabled={disabled || input.busy} onChange={event => {
      void input.add(Array.from(event.target.files ?? []));
      event.target.value = "";
    }} />
    <Button type="button" variant="ghost" size="icon" disabled={disabled || input.busy || input.images.length >= 4}
      aria-label={t("composer.attach_image", { defaultValue: "Attach images" })}
      title={t("composer.attach_image", { defaultValue: "Attach images" })}
      onClick={() => fileInput.current?.click()}><StreamAttachment size={ICON.sm} /></Button>
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
