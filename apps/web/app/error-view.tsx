"use client";

import { classifyError, describeError, type PublicError } from "@arilla/core/errors";
import { Button, ErrorNotice } from "@arilla/ui";
import { usePathname } from "next/navigation";
import actions from "./public-actions.module.css";

/** Metinler docs/copy.md `error.*` - anahtarlar yorumda. */
export const ERROR_VIEW_COPY = {
  retry: "Tekrar dene", // action.retry
  reload: "Sayfayı yenile", // action.reload
  login: "Yeniden giriş yap", // error.relogin
  referenceLabel: "Referans kodu:", // error.reference
} as const;

/**
 * Ortak hata gorunumu (karar 0104): kod -> katalog metni + uygun eylemler.
 * Sayfayi degistirmez; cagiran bunu mevcut icerigin YANINA koyar (sohbet gecmisi,
 * katalog sonuclari ve kullanici girdisi yerinde kalir). `onRetry` yoksa
 * "Tekrar dene" yerine sayfa yenileme sunulur.
 */
export function ErrorView({
  error,
  onRetry,
  disabled = false,
  extraActions,
  className,
}: {
  error: PublicError;
  onRetry?: () => void;
  disabled?: boolean;
  /** Birincil islemin yanina eklenen baglantilar (or. dogrudan ara). */
  extraActions?: React.ReactNode;
  className?: string;
}) {
  const pathname = usePathname();
  const info = describeError(error);
  // Yalnizca yol (sorgu/kimlik yok): giristen sonra ayni sayfaya donulur.
  const loginHref = `/giris?${new URLSearchParams({ next: pathname || "/" }).toString()}`;

  let primary: React.ReactNode = null;
  if (info.action === "login") {
    primary = (
      <a href={loginHref} className={actions.primary}>
        {ERROR_VIEW_COPY.login}
      </a>
    );
  } else if (info.action === "reload" || (info.action === "retry" && !onRetry)) {
    primary = (
      <Button variant="accent" shape="pill" onClick={() => window.location.reload()}>
        {ERROR_VIEW_COPY.reload}
      </Button>
    );
  } else if (info.action === "retry" && onRetry) {
    primary = (
      <Button variant="accent" shape="pill" disabled={disabled} onClick={onRetry}>
        {ERROR_VIEW_COPY.retry}
      </Button>
    );
  }

  return (
    <ErrorNotice
      title={info.title}
      message={info.message}
      reference={info.reference}
      referenceLabel={ERROR_VIEW_COPY.referenceLabel}
      actions={
        primary || extraActions ? (
          <>
            {primary}
            {extraActions}
          </>
        ) : null
      }
      className={className}
    />
  );
}

/**
 * Hata sinirina dusen hatayi kullanici hatasina cevirir. Uretimde sunucu hata
 * metni istemciye gelmez (yalnizca `digest`); neden bilinmiyorsa `unknown`.
 * Referans yalnizca sunucu logunda karsiligi olan `digest`tir.
 */
export function publicErrorFromBoundary(error: Error & { digest?: string }): PublicError {
  return {
    code: classifyError(error, { client: true }),
    ...(error.digest ? { reference: error.digest } : {}),
  };
}
