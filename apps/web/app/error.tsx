"use client";

import { describeError } from "@arilla/core/errors";
import { Button, Container, SkipLink } from "@arilla/ui";
import { useEffect } from "react";
import { ERROR_VIEW_COPY, publicErrorFromBoundary } from "./error-view.tsx";
import { HOME_COPY } from "./home-copy.ts";
import actions from "./public-actions.module.css";
import styles from "./system-state.module.css";

/** Metinler docs/copy.md `error.*` - anahtarlar yorumda. */
const ERROR_COPY = {
  title: "Bu sayfa şu an açılamadı.", // error.generic_title
  body: "Bir şeyler ters gitti. Tekrar dener misin?", // error.generic
  retry: "Tekrar dene", // action.retry
  homeAction: "Ana sayfaya dön", // error.home_action
} as const;

const MAIN_ID = "icerik";

/**
 * Kok hata siniri (Next 16: `retry()` segmenti yeniden getirip cizer). Kok
 * layout'u sarmaz; altindaki segment layout'larinin (public kabuk dahil)
 * yerine cizilir. Kabuk bir async Server Component (oturum okur) oldugu icin
 * burada kullanilamaz - minimal ust cubuk + tek `<main>` burada kurulur.
 * Hata ayrintisi kullaniciya gosterilmez.
 */
export default function RootError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  const info = describeError(publicErrorFromBoundary(error));
  // Neden bilinmiyorsa genel metin; biliniyorsa doğrulanmış açıklama (karar 0104).
  const known = info.code !== "unknown";
  const reloads = info.action === "reload";

  return (
    <div className={styles.bareShell}>
      <SkipLink targetId={MAIN_ID}>{HOME_COPY.skipToContent}</SkipLink>
      <header className={styles.bareHeader}>
        <Container size="wide" className={styles.bareHeaderInner}>
          <a href="/" className={styles.bareBrand}>
            Arilla
          </a>
        </Container>
      </header>
      <main id={MAIN_ID} tabIndex={-1} className={styles.bareMain}>
        <Container size="wide">
          <div className={styles.page}>
            <div className={styles.text}>
              <h1 className={styles.title}>{known ? info.title : ERROR_COPY.title}</h1>
              <p className={styles.body}>{known ? info.message : ERROR_COPY.body}</p>
              {info.reference ? (
                <p className={styles.body}>
                  {ERROR_VIEW_COPY.referenceLabel} {info.reference}
                </p>
              ) : null}
            </div>
            <div className={actions.actions}>
              <Button
                variant="accent"
                shape="pill"
                onClick={() => (reloads ? window.location.reload() : retry())}
              >
                {reloads ? ERROR_VIEW_COPY.reload : ERROR_COPY.retry}
              </Button>
              <a href="/" className={actions.secondary}>
                {ERROR_COPY.homeAction}
              </a>
            </div>
          </div>
        </Container>
      </main>
    </div>
  );
}
