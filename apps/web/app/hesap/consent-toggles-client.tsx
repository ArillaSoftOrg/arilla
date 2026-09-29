"use client";

import type { ConsentKind } from "@arilla/core";
import { useState, useTransition } from "react";
import { MARKETING_EMAIL_COPY } from "../marketing-email-copy.ts";
import { updateConsentAction, updateMarketingEmailAction } from "./actions.ts";
import styles from "./page.module.css";

export interface ConsentTogglesClientProps {
  historyAndPersonalization: boolean;
  marketingEmail: boolean;
  /** Adresi olmayan hesap (telefon, e-postasız Apple) pazarlama rızası veremez. */
  marketingEmailAvailable: boolean;
  /** Sürümlü rıza metni (packages/core/src/marketing/consent-text.ts). */
  marketingConsentText: string;
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
  marketingEmailAvailable,
  marketingConsentText,
  publicDiscovery,
}: ConsentTogglesClientProps) {
  const [history, setHistory] = useState(historyAndPersonalization);
  const [marketing, setMarketing] = useState(marketingEmail);
  const [marketingError, setMarketingError] = useState<string | null>(null);
  const [marketingPending, startMarketing] = useTransition();
  const [discovery, setDiscovery] = useState(publicDiscovery);

  // Pazarlama tercihi iyimser değil: düğme istek bitene kadar kilitli, sonuç
  // sunucunun döndürdüğü durumdur (docs/decisions/0046).
  function toggleMarketing(granted: boolean) {
    setMarketingError(null);
    startMarketing(async () => {
      try {
        const result = await updateMarketingEmailAction(granted);
        setMarketing(result.optedIn);
        if (result.error) {
          setMarketingError(
            result.error === "no_email"
              ? MARKETING_EMAIL_COPY.noEmail
              : MARKETING_EMAIL_COPY.saveFailed,
          );
        }
      } catch {
        setMarketingError(MARKETING_EMAIL_COPY.saveFailed);
      }
    });
  }

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
      disabled: false,
      error: null,
      onChange: (granted: boolean) =>
        toggle(["browsing_history", "personalization"], granted, setHistory),
    },
    {
      id: "marketing",
      title: MARKETING_EMAIL_COPY.preferenceTitle,
      description: marketingEmailAvailable
        ? `${marketingConsentText} ${MARKETING_EMAIL_COPY.transactionalNote}`
        : MARKETING_EMAIL_COPY.noEmail,
      checked: marketing,
      disabled: !marketingEmailAvailable || marketingPending,
      error: marketingError,
      onChange: toggleMarketing,
    },
    {
      id: "discovery",
      title: "Anonim keşif katkısı",
      description: "Bulduğun ürünler kimliğin görünmeden keşfet akışında yer alabilsin.",
      checked: discovery,
      disabled: false,
      error: null,
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
            {item.error ? (
              <span className={styles.preferenceDescription} role="alert">
                {item.error}
              </span>
            ) : null}
          </span>
          <span className={styles.switchControl}>
            <input
              type="checkbox"
              checked={item.checked}
              disabled={item.disabled}
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
