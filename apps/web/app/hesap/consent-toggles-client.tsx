"use client";

import type { ConsentKind } from "@arilla/core";
import { useState } from "react";
import { updateConsentAction } from "./actions.ts";

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

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={history}
          onChange={(event) =>
            toggle(["browsing_history", "personalization"], event.target.checked, setHistory)
          }
          style={{ marginTop: 4 }}
        />
        Gezinme geçmişimi kaydet, bana daha iyi öneriler göster.
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={marketing}
          onChange={(event) => toggle(["marketing_email"], event.target.checked, setMarketing)}
          style={{ marginTop: 4 }}
        />
        Haftalık fırsat özetini e-posta ile gönder.
      </label>
      <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <input
          type="checkbox"
          checked={discovery}
          onChange={(event) => toggle(["public_discovery"], event.target.checked, setDiscovery)}
          style={{ marginTop: 4 }}
        />
        Bulduğum ürünler isimsiz olarak keşfet akışında görünebilsin.
      </label>
    </div>
  );
}
