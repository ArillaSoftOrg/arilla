"use client";

import { Button } from "@arilla/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

const RESET_MS = 2500;

/**
 * Davet bağlantısı kartı: soluk etiket, büyük okunur bağlantı, tam genişlik
 * kopyalama düğmesi. Panoya TAM URL gider; ekranda şemasız hali görünür.
 * Pano yoksa bağlantı metni seçilebilir kalır.
 */
export function ReferralLinkClient({ url, display }: { url: string; display: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), RESET_MS);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className={styles.referralCard}>
      <p className={styles.referralLabel}>Yönlendirme bağlantınız</p>
      <p className={styles.referralUrl}>{display}</p>
      <Button type="button" variant="secondary" shape="pill" fullWidth onClick={copy}>
        {copied ? (
          <span className={styles.copiedLabel}>
            <svg
              aria-hidden="true"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8.5 6.5 12 13 4.5" />
            </svg>
            Kopyalandı
          </span>
        ) : (
          "Panoya kopyala"
        )}
      </Button>
      <span className={styles.srOnly} role="status">
        {copied ? "Davet bağlantısı panoya kopyalandı" : ""}
      </span>
    </div>
  );
}
