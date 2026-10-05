"use client";

import type { ConsentKind } from "@arilla/core";
import { useId, useState } from "react";
import { updateConsentAction } from "../actions.ts";
import styles from "./page.module.css";

/**
 * docs/copy.md `legal.consent_history` / `legal.consent_discovery`. Gezinme
 * geçmişi ve kişiselleştirme tek kutuda iki türü birlikte yazar (eski
 * `/hesap` davranışı). Kayıt başarısızsa kutu eski haline döner.
 */
export function PrivacyTogglesClient({
  historyAndPersonalization,
  publicDiscovery,
}: {
  historyAndPersonalization: boolean;
  publicDiscovery: boolean;
}) {
  const [history, setHistory] = useState(historyAndPersonalization);
  const [discovery, setDiscovery] = useState(publicDiscovery);
  const [error, setError] = useState(false);
  const baseId = useId();

  async function change(
    kinds: readonly ConsentKind[],
    granted: boolean,
    set: (value: boolean) => void,
  ) {
    setError(false);
    set(granted);
    try {
      await Promise.all(kinds.map((kind) => updateConsentAction(kind, granted)));
    } catch {
      set(!granted);
      setError(true);
    }
  }

  const items = [
    {
      id: `${baseId}-history`,
      title: "Kişiselleştirilmiş öneriler",
      description:
        "Gezinme geçmişini kaydederek daha isabetli ürün önerileri göstermemize izin ver.",
      checked: history,
      onChange: (granted: boolean) =>
        change(["browsing_history", "personalization"], granted, setHistory),
    },
    {
      id: `${baseId}-discovery`,
      title: "Anonim keşif katkısı",
      description: "Bulduğun ürünler kimliğin görünmeden keşfet akışında yer alabilsin.",
      checked: discovery,
      onChange: (granted: boolean) => change(["public_discovery"], granted, setDiscovery),
    },
  ] as const;

  return (
    <div className={styles.list}>
      {items.map((item) => (
        <label key={item.id} htmlFor={item.id} className={styles.item}>
          <span className={styles.copy}>
            <span className={styles.itemTitle}>{item.title}</span>
            <span className={styles.itemDescription}>{item.description}</span>
          </span>
          <input
            id={item.id}
            className={styles.switch}
            type="checkbox"
            role="switch"
            aria-checked={item.checked}
            checked={item.checked}
            onChange={(event) => item.onChange(event.currentTarget.checked)}
          />
        </label>
      ))}
      {error ? (
        <p className={styles.text} role="alert">
          Tercihin kaydedilemedi. Biraz sonra tekrar dene.
        </p>
      ) : null}
    </div>
  );
}
