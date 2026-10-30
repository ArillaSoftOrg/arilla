"use client";

import { Button } from "@arilla/ui";
import { useEffect, useId, useRef, useState } from "react";
import { canonicalShareUrl, type ShareOutcome, shareLink } from "./lib/share-link.ts";
import styles from "./share-button.module.css";

const RESET_MS = 2500;

/** docs/copy.md `share.*`. */
export const SHARE_COPY = {
  action: "Paylaş",
  copied: "Bağlantı kopyalandı",
  failed: "Bağlantı kopyalanamadı. Adresi seçip kopyalayabilirsin.",
  failedFieldLabel: { product: "Ürün bağlantısı", trend: "Koleksiyon bağlantısı" },
} as const;

export interface ShareButtonClientProps {
  /** Kanonik sayfa adresi; site adresi yoksa kök göreli ("/urun/x"). */
  url: string;
  title: string;
  subject: "product" | "trend";
}

type State = "idle" | "pending" | Exclude<ShareOutcome, "shared" | "cancelled">;

/**
 * Ürün ve trend sayfasındaki "Paylaş" düğmesi. Giriş istemez (SEO rotasında
 * giriş modali yok, karar 0002), analitik olayı göndermez (`docs/events.md`'de
 * paylaşım olayı tanımlı değil). Sonuç ekran okuyucuya `role="status"` ile
 * duyurulur; pano da yoksa adres seçilebilir alanda kalır.
 */
export function ShareButtonClient({ url, title, subject }: ShareButtonClientProps) {
  const [state, setState] = useState<State>("idle");
  const [resolved, setResolved] = useState(url);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fieldId = useId();

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function handleClick() {
    // Web Share aynı anda ikinci çağrıyı `InvalidStateError` ile reddeder.
    if (state === "pending") return;
    if (timer.current) clearTimeout(timer.current);
    const target = canonicalShareUrl(url, window.location.origin);
    if (!target) {
      setState("failed");
      return;
    }
    setResolved(target);
    setState("pending");
    const outcome = await shareLink(navigator, { url: target, title });
    if (outcome === "copied") {
      setState("copied");
      timer.current = setTimeout(() => setState("idle"), RESET_MS);
      return;
    }
    setState(outcome === "failed" ? "failed" : "idle");
  }

  return (
    <div className={styles.share}>
      <Button
        type="button"
        variant="secondary"
        className={styles.button}
        onClick={handleClick}
        aria-busy={state === "pending" || undefined}
      >
        <svg
          aria-hidden="true"
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3v12" />
          <path d="m7 8 5-5 5 5" />
          <path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6" />
        </svg>
        {SHARE_COPY.action}
      </Button>
      <p className={styles.status} role="status">
        {state === "copied" ? SHARE_COPY.copied : state === "failed" ? SHARE_COPY.failed : ""}
      </p>
      {state === "failed" ? (
        <div className={styles.fallback}>
          <label htmlFor={fieldId} className={styles.fieldLabel}>
            {SHARE_COPY.failedFieldLabel[subject]}
          </label>
          <input
            id={fieldId}
            className={styles.field}
            type="text"
            readOnly
            value={resolved}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      ) : null}
    </div>
  );
}
