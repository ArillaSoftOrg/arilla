"use client";

import type { ChangeEvent, ReactNode } from "react";
import { useRef } from "react";
import { Button, type ButtonProps } from "./Button.tsx";

export interface PhotoUploadButtonProps {
  label: string;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
  /** Yeni, opsiyonel - varsayilan false: bugunku etiketli buton korunur. */
  iconOnly?: boolean;
  /** iconOnly=true iken gorunen icerik; label erisilebilir isim olarak kalir. */
  icon?: ReactNode;
  className?: string;
  /** Yeni, opsiyonel - varsayilan "secondary": bugunku gorunum korunur. */
  variant?: ButtonProps["variant"];
}

/**
 * docs/pages.md "/": "Fotoğraf yükleme aynı girdinin içinde." Sunum katmanı
 * yalnızca dosya seçimini dışarı verir; yükleme/embedding mantığı apps/web'in
 * ince istemci katmanındadır.
 */
export function PhotoUploadButton({
  label,
  onFileSelected,
  disabled,
  iconOnly = false,
  icon,
  className,
  variant = "secondary",
}: PhotoUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Ayni dosya tekrar secilirse de onChange tetiklensin.
    event.target.value = "";
    if (file) onFileSelected(file);
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        onChange={handleChange}
        hidden
      />
      <Button
        type="button"
        variant={variant}
        className={className}
        disabled={disabled}
        aria-label={iconOnly ? label : undefined}
        onClick={() => inputRef.current?.click()}
      >
        {iconOnly ? icon : label}
      </Button>
    </>
  );
}
