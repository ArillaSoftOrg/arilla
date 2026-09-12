"use client";

import { Button } from "@arilla/ui";
import { useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { createAlertAction, saveItemAction } from "./actions.ts";

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

  async function handleSave() {
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

  async function handleAlertButtonClick() {
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
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", gap: 8 }}>
        <Button
          type="button"
          variant="secondary"
          disabled={saveState !== "idle"}
          onClick={handleSave}
        >
          {saveState === "saved" ? "Kaydedildi" : "Kaydet"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={alertState !== "idle"}
          onClick={handleAlertButtonClick}
        >
          {alertState === "created" ? "Alarm kuruldu" : "Fiyat alarmı kur"}
        </Button>
      </div>

      {alertState === "created" ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>
          {isInStock
            ? `${targetPrice} TL altına düşünce haber vereceğiz.`
            : "Stoğa girince haber vereceğiz."}
        </p>
      ) : null}

      {showPriceForm ? (
        <form
          onSubmit={handlePriceFormSubmit}
          style={{ display: "flex", gap: 8, alignItems: "center" }}
        >
          <input
            type="number"
            min={1}
            step={1}
            value={targetPrice}
            onChange={(event) => setTargetPrice(event.target.value)}
            aria-label="Hedef fiyat (TL)"
            style={{ width: 100, minHeight: 44 }}
          />
          <span style={{ fontSize: 13, color: "var(--ink-muted)" }}>
            TL altına düşünce haber ver
          </span>
          <Button type="submit" variant="primary">
            Kur
          </Button>
        </form>
      ) : null}

      <LoginGateModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </div>
  );
}
