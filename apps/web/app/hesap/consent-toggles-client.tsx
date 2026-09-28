"use client";

import type { ConsentKind } from "@arilla/core";
import { useState } from "react";
import { updateConsentAction } from "./actions.ts";
import styles from "./page.module.css";

export interface ConsentTogglesClientProps {
  historyAndPersonalization: boolean;
  marketingEmail: boolean;
  publicDiscovery: boolean;
}

/**
 * docs/copy.md `legal.consent_*`. `legal.consent_history` metni tek cümlede
 * hem kaydı hem kişiselleştirmeyi anlatıyor (docs/kvkk.md: "Gezinme geçmişi
 * ve kişiselleştirme rızaya bağlıdır" - ikisi birlikte anılır) - bu yüzden
 * tek kutu her iki `kind`'ı da (`browsing_history`, `personalization`) aynı
 * anda yazar.
 */
export function ConsentTogglesClient({
  historyAndPersonalization,
  marketingEmail,
  publicDiscovery,
}: ConsentTogglesClientProps) {
  const [history, setHistory] = useState(historyAndPersonalization);
  const [marketing, setMarketing] = useState(marketingEmail);
  const [discovery, setDiscovery] = useState(publicDiscovery);

  async function toggle(
    kinds: readonly ConsentKind[],
    granted: boolean,
    setState: (value: boolean) => void,
  ) {
    setState(granted);
    await Promise.all(kinds.map((kind) => updateConsentAction(kind, granted)));
  }

  const items = [
    {
      id: "history",
      title: "Kişiselleştirilmiş öneriler",
      description:
        "Gezinme geçmişini kaydederek daha isabetli ürün önerileri göstermemize izin ver.",
      checked: history,
      onChange: (granted: boolean) =>
        toggle(["browsing_history", "personalization"], granted, setHistory),
    },
    {
      id: "marketing",
      title: "Haftalık fırsat özeti",
      description: "Fırsat özetlerini ve önemli ürün güncellemelerini e-posta ile al.",
      checked: marketing,
      onChange: (granted: boolean) => toggle(["marketing_email"], granted, setMarketing),
    },
    {
      id: "discovery",
      title: "Anonim keşif katkısı",
      description: "Bulduğun ürünler kimliğin görünmeden keşfet akışında yer alabilsin.",
      checked: discovery,
      onChange: (granted: boolean) => toggle(["public_discovery"], granted, setDiscovery),
    },
  ] as const;

  return (
    <div className={styles.preferenceList}>
      {items.map((item) => (
        <label key={item.id} className={styles.preferenceItem}>
          <span className={styles.preferenceCopy}>
            <span className={styles.preferenceTitle}>{item.title}</span>
            <span className={styles.preferenceDescription}>{item.description}</span>
          </span>
          <span className={styles.switchControl}>
            <input
              type="checkbox"
              checked={item.checked}
              onChange={(event) => item.onChange(event.target.checked)}
            />
            <span className={styles.switchTrack} aria-hidden="true">
              <span className={styles.switchThumb} />
            </span>
          </span>
        </label>
      ))}
    </div>
  );
}
