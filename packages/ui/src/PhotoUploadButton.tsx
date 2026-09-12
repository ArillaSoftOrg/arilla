"use client";

import type { ChangeEvent } from "react";
import { useRef } from "react";
import { Button } from "./Button.tsx";

export interface PhotoUploadButtonProps {
  label: string;
  onFileSelected: (file: File) => void;
  disabled?: boolean;
}

/**
 * docs/pages.md "/": "Fotoğraf yükleme aynı girdinin içinde." Sunum katmanı
 * yalnızca dosya seçimini dışarı verir; yükleme/embedding mantığı apps/web'in
 * ince istemci katmanındadır.
 */
export function PhotoUploadButton({ label, onFileSelected, disabled }: PhotoUploadButtonProps) {
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
        variant="secondary"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
      >
        {label}
      </Button>
    </>
  );
}
