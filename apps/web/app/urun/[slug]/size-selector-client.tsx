"use client";

import { SizeSelector, type SizeSelectorOption } from "@arilla/ui";
import { useState } from "react";
import { LoginGateModal } from "../../login-gate-modal-client.tsx";
import { createAlertAction } from "./actions.ts";

export interface SizeSelectorClientProps {
  productId: number;
  sizes: readonly SizeSelectorOption[];
}

/** docs/copy.md `alert.size_created`. Olmayan bedene tıklama -> `size_restock` alarmı. */
export function SizeSelectorClient({ productId, sizes }: SizeSelectorClientProps) {
  const [notifiedSizes, setNotifiedSizes] = useState<ReadonlySet<string>>(new Set());
  const [loginModalOpen, setLoginModalOpen] = useState(false);

  async function handleNotifyMe(sizeNorm: string) {
    if (notifiedSizes.has(sizeNorm)) return;
    const status = await createAlertAction({ productId, kind: "size_restock", sizeNorm });
    if (status === "unauthenticated") {
      setLoginModalOpen(true);
      return;
    }
    setNotifiedSizes((prev) => new Set(prev).add(sizeNorm));
  }

  const lastNotifiedSize = sizes.find((size) => notifiedSizes.has(size.sizeNorm));

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <SizeSelector
        sizes={sizes}
        unavailableLabel="Bu beden şu an yok"
        notifyMeLabel="Bu beden gelince haber ver"
        onNotifyMe={handleNotifyMe}
      />
      {lastNotifiedSize ? (
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-muted)" }}>
          {lastNotifiedSize.label} bedeni gelince haber vereceğiz.
        </p>
      ) : null}
      <LoginGateModal open={loginModalOpen} onClose={() => setLoginModalOpen(false)} />
    </div>
  );
}
