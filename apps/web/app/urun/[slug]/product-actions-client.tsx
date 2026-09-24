"use client";

import { Button, Input } from "@arilla/ui";
import { useRef, useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { createAlertAction, saveItemAction } from "./actions.ts";
import styles from "./product-page.module.css";

export interface ProductActionsClientProps {
  productId: number;
  isInStock: boolean;
  /** Girdi alanının ön dolgusu için, TL cinsinden (tam sayı). */
  currentPriceTRY: number | null;
}

type SaveState = "idle" | "pending" | "saved";
type AlertState = "idle" | "pending" | "created";

/**
 * docs/copy.md `action.save`/`action.saved`/`action.create_alert`, docs/
 * pages.md bölüm 8. Girişi olmayan ziyaretçi için `/giris`'e düz link yerine
 * ortak giriş modalı açılır (decision 0002, trigger=save/alert).
 *
 * "Fiyat alarmı kur" ürünün stok durumuna göre farklı `kind` üretir: stokta
 * ise hedef fiyat sorup `price_drop`, değilse doğrudan `restock` - tek buton,
 * copy.md'nin tek `action.create_alert` anahtarına karşılık gelir.
 */
export function ProductActionsClient({
  productId,
  isInStock,
  currentPriceTRY,
}: ProductActionsClientProps) {
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [alertState, setAlertState] = useState<AlertState>("idle");
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [targetPrice, setTargetPrice] = useState(
    currentPriceTRY !== null ? String(currentPriceTRY) : "",
  );
  const [loginModalOpen, setLoginModalOpen] = useState(false);
  // Istek sirasinda dugme `disabled` olur ve tarayici odagi <body>'ye tasir;
  // modal kapaninca odagin donecegi dugme burada tutulur.
  const modalTriggerRef = useRef<HTMLElement | null>(null);

  async function handleSave(event: React.MouseEvent<HTMLButtonElement>) {
    modalTriggerRef.current = event.currentTarget;
    if (saveState === "pending" || saveState === "saved") return;
    setSaveState("pending");
    const status = await saveItemAction(productId);
    if (status === "unauthenticated") {
      setSaveState("idle");
      setLoginModalOpen(true);
      return;
    }
    setSaveState("saved");
  }

  async function handleAlertButtonClick(event: React.MouseEvent<HTMLButtonElement>) {
    // Fiyat formu gonderiminde "Kur" dugmesi kaldirilir; odak alarm dugmesine doner.
    modalTriggerRef.current = event.currentTarget;
    if (alertState !== "idle") return;
    if (isInStock) {
      setShowPriceForm(true);
      return;
    }
    await submitAlert({ productId, kind: "restock" });
  }

  async function handlePriceFormSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const tl = Number(targetPrice);
    if (!Number.isFinite(tl) || tl <= 0) return;
    await submitAlert({ productId, kind: "price_drop", targetPrice: Math.round(tl * 100) });
  }

  async function submitAlert(input: Parameters<typeof createAlertAction>[0]) {
    setAlertState("pending");
    setShowPriceForm(false);
    const status = await createAlertAction(input);
    if (status === "unauthenticated") {
      setAlertState("idle");
      setLoginModalOpen(true);
      return;
    }
    setAlertState("created");
  }

  return (
    <div className={styles.actions}>
      <div className={styles.actionButtons}>
        <Button
          type="button"
          variant="secondary"
          disabled={saveState !== "idle"}
          onClick={handleSave}
          className={styles.actionButton}
        >
          {saveState === "saved" ? "Kaydedildi" : "Kaydet"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={alertState !== "idle"}
          onClick={handleAlertButtonClick}
          className={styles.actionButton}
        >
          {alertState === "created" ? "Alarm kuruldu" : "Fiyat alarmı kur"}
        </Button>
      </div>

      {/* Canli bolge once bos olarak var olmali ki sonradan gelen metin okunsun. */}
      <p role="status" className={styles.statusText}>
        {alertState === "created"
          ? isInStock
            ? `${targetPrice} TL altına düşünce haber vereceğiz.`
            : "Stoğa girince haber vereceğiz."
          : null}
      </p>

      {showPriceForm ? (
        <form onSubmit={handlePriceFormSubmit} className={styles.alertForm}>
          <div className={styles.alertField}>
            <Input
              label="Hedef fiyat (TL)"
              hint="TL altına düşünce haber ver"
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={targetPrice}
              onChange={(event) => setTargetPrice(event.target.value)}
              className="tabular-nums"
            />
          </div>
          <Button type="submit" variant="primary" className={styles.alertSubmit}>
            Kur
          </Button>
        </form>
      ) : null}

      <LoginGateModal
        open={loginModalOpen}
        onClose={() => setLoginModalOpen(false)}
        returnFocusRef={modalTriggerRef}
      />
    </div>
  );
}
