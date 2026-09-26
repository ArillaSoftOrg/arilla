"use client";

import { useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { createAlertAction } from "./actions.ts";
import styles from "./product-page.module.css";

export interface VariantRestockClientProps {
  productId: number;
  /**
   * Alarmin varyant kimligi (0037): `?boyut=` ile ayni cozumlenmis anahtar.
   * Beden icin `size_norm` ("42"), hacim icin anahtar ("100ml").
   */
  sizeNorm: string;
  /** Kullaniciya gorunen etiket ("100 ml"). */
  label: string;
}

/**
 * Varyant modunda stok alarmi: secili varyant hicbir uyumlu teklifte stokta
 * degilken gorunur. Ikinci bir boyut secici YOKTUR; secim sayfadaki
 * `?boyut=` durumudur.
 */
export function VariantRestockClient({ productId, sizeNorm, label }: VariantRestockClientProps) {
  const [status, setStatus] = useState<"idle" | "created" | "error">("idle");
  const [loginModalOpen, setLoginModalOpen] = useState(false);

  async function handleClick() {
    if (status === "created") return;
    const result = await createAlertAction({ productId, kind: "size_restock", sizeNorm });
    if (result === "unauthenticated") {
      setLoginModalOpen(true);
      return;
    }
    // Ayni varyant icin alarm zaten varsa kullanici icin sonuc aynidir.
    setStatus(result === "ok" || result === "already_exists" ? "created" : "error");
  }

  return (
    <div className={styles.fieldGroup}>
      <button
        type="button"
        className={styles.compareLink}
        onClick={handleClick}
        aria-pressed={status === "created"}
      >
        {status === "created" ? `${label} için alarm kuruldu` : "Stok gelince haber ver"}
      </button>
      {/* Canli bolge once bos olarak var olmali ki sonradan gelen metin okunsun. */}
      <p role="status" className={styles.statusText}>
        {status === "created"
          ? `${label} stoğa gelince haber vereceğiz.`
          : status === "error"
            ? "Alarm şu an kurulamadı. Biraz sonra tekrar dener misin?"
            : null}
      </p>
      <LoginGateModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </div>
  );
}
