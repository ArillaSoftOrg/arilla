import type { ReactNode } from "react";
import styles from "./ErrorNotice.module.css";
import { joinClassNames } from "./layout.ts";

/**
 * Ortak hata notu (karar 0104): baslik, anlasilir aciklama, istege bagli destek
 * referansi ve eylemler. Metni bilmez; `apps/web` hata katalogundan doldurur.
 * Sayfanin yerini almaz - bolum ya da satir ici kullanilir, mevcut icerik
 * (sonuclar, sohbet gecmisi) yaninda durur.
 *
 * Erisilebilirlik: `role="alert"` (ekran okuyucu hemen okur). Durum renkle
 * degil, metin ve kenar ile anlatilir.
 */
export interface ErrorNoticeProps {
  title: string;
  message: string;
  /** Destek referans kimligi (or. `ARL-K7M2Q9XA`). */
  reference?: string;
  referenceLabel?: string;
  /** Eylemler (Button / baglanti); yoksa satir cizilmez. */
  actions?: ReactNode;
  className?: string;
}

export function ErrorNotice({
  title,
  message,
  reference,
  referenceLabel = "Referans kodu:",
  actions,
  className,
}: ErrorNoticeProps) {
  return (
    <div role="alert" className={joinClassNames(styles.notice, className)}>
      <p className={styles.title}>{title}</p>
      <p className={styles.message}>{message}</p>
      {reference ? (
        <p className={styles.reference}>
          {referenceLabel} <span className={styles.referenceCode}>{reference}</span>
        </p>
      ) : null}
      {actions ? <div className={styles.actions}>{actions}</div> : null}
    </div>
  );
}
