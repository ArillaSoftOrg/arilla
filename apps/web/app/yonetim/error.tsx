"use client";

import { Button } from "@arilla/ui";
import { useEffect } from "react";
import styles from "./admin.module.css";
import { ErrorNotice, PageHeader } from "./admin-ui.tsx";

/**
 * Yönetim alanının hata sınırı. Yönetim kabuğunun (yan menü) İÇİNDE çizilir:
 * bir sayfanın sorgusu patlarsa yönetici menüyü ve oturumu kaybetmez, kök
 * public hata ekranına düşmez. Hata ayrıntısı gösterilmez; yalnızca destek
 * için Next'in özet kimliği (`digest`, sunucu günlüğündeki kayıtla eşleşir).
 * Next 16: `retry()` segmenti yeniden getirip çizer.
 */
export default function YonetimError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className={styles.pageNarrow}>
      <PageHeader title="Bu sayfa açılamadı" />
      <ErrorNotice>
        Veriler yüklenirken bir hata oluştu. Tekrar dene; sorun sürerse sunucu günlüğüne bak.
        {error.digest ? (
          <>
            {" "}
            Hata kimliği: <code>{error.digest}</code>
          </>
        ) : null}
      </ErrorNotice>
      <div className={styles.row}>
        <Button type="button" variant="primary" onClick={() => retry()}>
          Tekrar dene
        </Button>
        <a href="/yonetim">Genel bakışa dön</a>
      </div>
    </div>
  );
}
