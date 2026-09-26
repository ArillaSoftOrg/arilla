"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { enqueueLinkResolutionAction, pollLinkResolutionAction } from "./actions.ts";
import styles from "./link-wait-client.module.css";

const POLL_INTERVAL_MS = 2000;
/** ~30 sn - `docs/architecture.md`'nin "3 saniyelik hedefi" burada geçerli
 * değil (Katman 2 gerçek bir sayfa getirir), ama sonsuza kadar da beklenmez. */
const MAX_POLLS = 15;

export function LinkWaitClient({ urlRaw }: { urlRaw: string }) {
  const router = useRouter();
  const [failed, setFailed] = useState(false);
  const urlLabel = useMemo(() => {
    try {
      return new URL(urlRaw).hostname;
    } catch {
      return urlRaw;
    }
  }, [urlRaw]);

  useEffect(() => {
    let cancelled = false;
    let pollCount = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedulePoll(requestId: string) {
      timer = setTimeout(async () => {
        if (cancelled) return;
        pollCount += 1;
        const result = await pollLinkResolutionAction(requestId);
        if (cancelled) return;

        if (result.status === "resolved" && result.productSlug) {
          router.push(`/urun/${result.productSlug}`);
          return;
        }
        if (result.status === "failed" || result.status === "not_found" || pollCount >= MAX_POLLS) {
          setFailed(true);
          return;
        }
        schedulePoll(requestId);
      }, POLL_INTERVAL_MS);
    }

    enqueueLinkResolutionAction(urlRaw)
      .then(({ requestId }) => {
        if (!cancelled) schedulePoll(requestId);
      })
      // Kuyruk erisilemezse sonsuz bekleme yerine bos durum gosterilir.
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [urlRaw, router]);

  if (failed) {
    return (
      <section className={styles.shell} aria-labelledby="link-wait-title">
        <div className={styles.card}>
          <div className={styles.visual} aria-hidden="true">
            <div className={styles.panel}>
              <span className={styles.urlPill}>{urlLabel}</span>
              <span className={styles.pulse}>!</span>
            </div>
          </div>
          <div className={styles.copy}>
            <h1 className={styles.title} id="link-wait-title">
              Bağlantıyı çözemedik
            </h1>
            <p className={styles.description}>
              Ürünü mağazada açabilir ya da Arilla ana sayfasından görsel veya metinle tekrar
              arayabilirsin.
            </p>
          </div>
          <div className={styles.actions}>
            <a className={styles.primary} href={urlRaw} rel="noopener noreferrer" target="_blank">
              Orijinal bağlantıyı aç
            </a>
            <a className={styles.secondary} href="/">
              Ana sayfaya dön
            </a>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={styles.shell} aria-labelledby="link-wait-title">
      <div className={styles.card}>
        <div className={styles.visual} aria-hidden="true">
          <div className={styles.panel}>
            <span className={styles.urlPill}>{urlLabel}</span>
            <span className={styles.pulse}>→</span>
          </div>
        </div>
        <div className={styles.copy}>
          <h1 className={styles.title} id="link-wait-title">
            Ürünü arıyoruz
          </h1>
          <p className={styles.description}>
            Bağlantıyı çözümlüyor, benzer ürünleri ve mağaza seçeneklerini hazırlıyoruz.
          </p>
        </div>
      </div>
    </section>
  );
}
