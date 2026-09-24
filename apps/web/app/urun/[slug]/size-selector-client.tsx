"use client";

import { SizeSelector, type SizeSelectorOption } from "@arilla/ui";
import { useId, useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { createAlertAction } from "./actions.ts";
import styles from "./product-page.module.css";

export interface SizeSelectorClientProps {
  productId: number;
  sizes: readonly SizeSelectorOption[];
}

/** docs/copy.md `alert.size_created`. Olmayan bedene tıklama -> `size_restock` alarmı. */
export function SizeSelectorClient({ productId, sizes }: SizeSelectorClientProps) {
  const [notifiedSizes, setNotifiedSizes] = useState<ReadonlySet<string>>(new Set());
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  // Durum mesaji listedeki ilk degil, en son tiklanan bedeni soyler.
  const [lastNotifiedSizeNorm, setLastNotifiedSizeNorm] = useState<string | null>(null);
  const labelId = useId();

  async function handleNotifyMe(sizeNorm: string) {
    if (notifiedSizes.has(sizeNorm)) return;
    const status = await createAlertAction({ productId, kind: "size_restock", sizeNorm });
    if (status === "unauthenticated") {
      setLoginModalOpen(true);
      return;
    }
    setNotifiedSizes((prev) => new Set(prev).add(sizeNorm));
    setLastNotifiedSizeNorm(sizeNorm);
  }

  if (sizes.length === 0) return null;

  const lastNotifiedSize = sizes.find((size) => size.sizeNorm === lastNotifiedSizeNorm);

  return (
    <div className={styles.fieldGroup}>
      <p id={labelId} className={styles.fieldLabel}>
        Beden
      </p>
      <SizeSelector
        sizes={sizes}
        unavailableLabel="Bu beden şu an yok"
        notifyMeLabel="Bu beden gelince haber ver"
        onNotifyMe={handleNotifyMe}
        aria-labelledby={labelId}
      />
      {/* Canli bolge once bos olarak var olmali ki sonradan gelen metin okunsun. */}
      <p role="status" className={styles.statusText}>
        {lastNotifiedSize ? `${lastNotifiedSize.label} bedeni gelince haber vereceğiz.` : null}
      </p>
      <LoginGateModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </div>
  );
}
