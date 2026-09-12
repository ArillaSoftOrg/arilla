"use client";

import { PhotoUploadButton } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uploadImageForSearch } from "./ara/gorsel/actions.ts";

const UPLOAD_LABEL = "Fotoğraf yükle";
const LOADING_LABEL = "Benzerlerini arıyoruz";

const ERROR_COPY: Record<string, string> = {
  too_large: "Fotoğraf çok büyük. Daha küçük bir dosya dener misin?",
  invalid_type: "Bir şeyler ters gitti. Tekrar dener misin?",
  daily_limit: "Bugünlük görsel arama hakkın doldu. Yarın tekrar bekleriz.",
  error: "Bir şeyler ters gitti. Tekrar dener misin?",
};

/** docs/pages.md "/" ve "/ara": fotoğraf yükleme aynı arama girdisinin yanında. */
export function PhotoSearchButton() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleFile(file: File) {
    setError(null);
    const formData = new FormData();
    formData.set("photo", file);
    startTransition(async () => {
      const result = await uploadImageForSearch(formData);
      if (result.status === "ok") {
        router.push(`/ara/gorsel?id=${result.imageUploadId}`);
        return;
      }
      setError(
        ERROR_COPY[result.status] ??
          ERROR_COPY.error ??
          "Bir şeyler ters gitti. Tekrar dener misin?",
      );
    });
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <PhotoUploadButton
        label={pending ? LOADING_LABEL : UPLOAD_LABEL}
        onFileSelected={handleFile}
        disabled={pending}
      />
      {error ? (
        <p role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
