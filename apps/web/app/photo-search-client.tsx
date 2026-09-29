"use client";

import { PhotoUploadButton, Stack } from "@arilla/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { uploadImageForSearch } from "./ara/gorsel/actions.ts";
import { SEARCH_RIGHTS_COPY, SEARCH_RIGHTS_HREF } from "./ara/search-rights-copy.ts";
import { LoginGateModal } from "./login-gate-modal-client.tsx";
import styles from "./photo-search-client.module.css";

export const PHOTO_SEARCH_UPLOAD_LABEL = "Fotoğraf yükle"; // action.upload_photo
export const PHOTO_SEARCH_LOADING_LABEL = "Benzerlerini arıyoruz"; // search.loading

/** `ara/gorsel/actions.ts` MAX_UPLOAD_BYTES ile aynı; gövde sınırına takılmadan önce yakalanır. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

const ERROR_COPY: Record<string, string> = {
  too_large: "Fotoğraf çok büyük. 4 MB'tan küçük bir dosya dener misin?",
  invalid_type: "Bir şeyler ters gitti. Tekrar dener misin?",
  unprocessable: "Bu görseli işleyemedik. Başka bir fotoğrafla yeniden dener misin?",
  no_rights: SEARCH_RIGHTS_COPY.noRights,
  rate_limited: SEARCH_RIGHTS_COPY.rateLimited,
  busy: SEARCH_RIGHTS_COPY.busy,
  retry: "Bir şeyler ters gitti. Tekrar dener misin?",
  unavailable: "Fotoğrafla arama şu an kullanılamıyor. Biraz sonra tekrar dener misin?",
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
  const [noRights, setNoRights] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);

  function handleFile(file: File) {
    setError(null);
    setNoRights(false);
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(ERROR_COPY.too_large ?? null);
      return;
    }
    const formData = new FormData();
    formData.set("photo", file);
    // Her secim yeni bir istek: cift tiklama/yeniden gonderim ayni anahtarla
    // gelirse sunucu ikinci kez hak harcamaz (0046).
    formData.set("requestKey", crypto.randomUUID());
    startTransition(async () => {
      const result = await uploadImageForSearch(formData);
      if (result.status === "ok") {
        router.push(`/ara/gorsel?id=${result.imageUploadId}`);
        router.refresh();
        return;
      }
      if (result.status === "login_required") {
        setLoginOpen(true);
        return;
      }
      setNoRights(result.status === "no_rights");
      setError(
        ERROR_COPY[result.status] ??
          ERROR_COPY.error ??
          "Bir şeyler ters gitti. Tekrar dener misin?",
      );
    });
  }

  return {
    pending,
    error,
    noRights,
    handleFile,
    loginOpen,
    closeLogin: () => setLoginOpen(false),
  };
}

/** docs/pages.md "/ara": fotoğraf yükleme aynı arama girdisinin yanında. */
export function PhotoSearchButton() {
  const { pending, error, noRights, handleFile, loginOpen, closeLogin } = usePhotoSearchUpload();

  return (
    <Stack gap={2}>
      <LoginGateModal open={loginOpen} onClose={closeLogin} />
      <PhotoUploadButton
        label={pending ? PHOTO_SEARCH_LOADING_LABEL : PHOTO_SEARCH_UPLOAD_LABEL}
        onFileSelected={handleFile}
        disabled={pending}
      />
      {error ? (
        <p role="alert" className={styles.error}>
          {error}{" "}
          {noRights ? <Link href={SEARCH_RIGHTS_HREF}>{SEARCH_RIGHTS_COPY.earnLink}</Link> : null}
        </p>
      ) : null}
    </Stack>
  );
}
