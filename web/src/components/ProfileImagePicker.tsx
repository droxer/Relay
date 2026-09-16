"use client";

import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import {
  ActionImage,
  ActionRemove,
  ICON,
} from "./icons";
import { Button } from "@/components/ui/button";
import { PresetAvatarGrid } from "./PresetAvatarGrid";
import { isPresetAvatarUrl, type PresetAvatarKind } from "../lib/presetAvatars";

const ACCEPTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const MAX_PROFILE_IMAGE_BYTES = 2 * 1024 * 1024;

export function ProfileImage({
  src,
  alt,
  fallback,
  className = "",
}: {
  src?: string | null;
  alt: string;
  fallback: ReactNode;
  className?: string;
}) {
  return (
    <span className={`profile-image${className ? ` ${className}` : ""}`} data-has-image={src ? "true" : "false"}>
      {src ? <img src={src} alt={alt} /> : fallback}
    </span>
  );
}

export function ProfileImagePicker({
  imageUrl,
  name,
  fallback,
  editable,
  disabled = false,
  onUpload,
  onRemove,
  presets,
}: {
  imageUrl?: string | null;
  name: string;
  fallback: ReactNode;
  editable: boolean;
  disabled?: boolean;
  onUpload: (dataUrl: string) => Promise<void>;
  onRemove: () => Promise<void>;
  /** When set, the trigger opens a popover of preset images with upload as
      the secondary choice, instead of going straight to the file dialog. */
  presets?: { kind: PresetAvatarKind; onSelect: (url: string) => Promise<void> };
}) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetsOpen, setPresetsOpen] = useState(false);

  async function selectPreset(url: string) {
    if (!presets) return;
    setError(null);
    setPresetsOpen(false);
    try {
      await presets.onSelect(url);
    } catch (selectError) {
      setError(selectError instanceof Error ? selectError.message : t("profile_image.failed"));
    }
  }

  function chooseUpload() {
    setPresetsOpen(false);
    inputRef.current?.click();
  }

  async function selectImage(file: File | undefined) {
    if (!file) return;
    if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
      setError(t("profile_image.unsupported"));
      return;
    }
    if (file.size > MAX_PROFILE_IMAGE_BYTES) {
      setError(t("profile_image.too_large"));
      return;
    }
    setError(null);
    try {
      await onUpload(await readFileAsDataUrl(file));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t("profile_image.failed"));
    } finally {
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function removeImage() {
    setError(null);
    try {
      await onRemove();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : t("profile_image.failed"));
    }
  }

  const image = (
    <ProfileImage
      src={imageUrl}
      alt={imageUrl ? t("profile_image.alt", { name }) : ""}
      fallback={fallback}
      className="profile-image-picker-visual"
    />
  );

  return (
    <div className="profile-image-picker">
      {editable ? (
        <>
          <input
            ref={inputRef}
            className="sr-only"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            aria-label={t("profile_image.choose")}
            disabled={disabled}
            onChange={(event) => void selectImage(event.target.files?.[0])}
          />
          {presets ? (
            <PopoverPrimitive.Root open={presetsOpen} onOpenChange={setPresetsOpen}>
              <PopoverPrimitive.Trigger
                disabled={disabled}
                render={
                  <Button
                    variant="ghost"
                    type="button"
                    className="profile-image-picker-trigger"
                    aria-label={imageUrl ? t("profile_image.change") : t("profile_image.choose")}
                    disabled={disabled}
                  />
                }
              >
                {image}
                <span className="profile-image-picker-action" aria-hidden="true">
                  <ActionImage size={ICON.sm} />
                </span>
              </PopoverPrimitive.Trigger>
              <PopoverPrimitive.Portal>
                <PopoverPrimitive.Positioner
                  side="bottom"
                  align="start"
                  sideOffset={8}
                  collisionPadding={8}
                  className="isolate z-(--z-float)"
                >
                  <PopoverPrimitive.Popup className="profile-image-presets">
                    <PopoverPrimitive.Title className="profile-image-presets-title">
                      {t("profile_image.presets")}
                    </PopoverPrimitive.Title>
                    <PresetAvatarGrid
                      kind={presets.kind}
                      value={isPresetAvatarUrl(presets.kind, imageUrl) ? imageUrl ?? null : null}
                      onChange={(url) => void selectPreset(url)}
                      disabled={disabled}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      type="button"
                      className="profile-image-presets-upload"
                      disabled={disabled}
                      onClick={chooseUpload}
                    >
                      <ActionImage size={ICON.sm} />
                      {t("profile_image.upload")}
                    </Button>
                  </PopoverPrimitive.Popup>
                </PopoverPrimitive.Positioner>
              </PopoverPrimitive.Portal>
            </PopoverPrimitive.Root>
          ) : (
            <Button
              variant="ghost"
              type="button"
              className="profile-image-picker-trigger"
              tooltip={imageUrl ? t("profile_image.change") : t("profile_image.choose")}
              disabled={disabled}
              onClick={() => inputRef.current?.click()}
            >
              {image}
              <span className="profile-image-picker-action" aria-hidden="true">
                <ActionImage size={ICON.sm} />
              </span>
            </Button>
          )}
          {imageUrl ? (
            <Button
              variant="ghost"
              danger
              type="button"
              className="profile-image-picker-remove"
              tooltip={t("profile_image.remove")}
              disabled={disabled}
              onClick={() => void removeImage()}
            >
              <ActionRemove size={ICON.xs} />
            </Button>
          ) : null}
        </>
      ) : image}
      {error ? <span className="profile-image-picker-error" role="alert">{error}</span> : null}
    </div>
  );
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Unable to read the selected image."));
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Unable to read the selected image."));
    };
    reader.readAsDataURL(file);
  });
}
