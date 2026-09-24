"use client";

import { PhotoUploadButton, Stack } from "@arilla/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uploadImageForSearch } from "./ara/gorsel/actions.ts";
import styles from "./photo-search-client.module.css";

export const PHOTO_SEARCH_UPLOAD_LABEL = "Fotoğraf yükle"; // action.upload_photo
export const PHOTO_SEARCH_LOADING_LABEL = "Benzerlerini arıyoruz"; // search.loading

const ERROR_COPY: Record<string, string> = {
  too_large: "Fotoğraf çok büyük. Daha küçük bir dosya dener misin?",
  invalid_type: "Bir şeyler ters gitti. Tekrar dener misin?",
  daily_limit: "Bugünlük görsel arama hakkın doldu. Yarın tekrar bekleriz.",
  error: "Bir şeyler ters gitti. Tekrar dener misin?",
};

/**
 * docs/pages.md "/" ve "/ara": fotoğraf yükleme akışı. JSX/davranışı
 * `PhotoSearchButton` ve homepage'in composer entegrasyonu arasında
 * tekrar yazılmadan paylaşılır.
 */
export function usePhotoSearchUpload() {
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

  return { pending, error, handleFile };
}

/** docs/pages.md "/ara": fotoğraf yükleme aynı arama girdisinin yanında. */
export function PhotoSearchButton() {
  const { pending, error, handleFile } = usePhotoSearchUpload();

  return (
    <Stack gap={2}>
      <PhotoUploadButton
        label={pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL}
        onFileSelected={handleFile}
        disabled={pending}
      />
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
    </Stack>
  );
}
