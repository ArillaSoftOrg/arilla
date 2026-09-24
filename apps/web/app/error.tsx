"use client";

import { Button, Container, SkipLink } from "@arilla/ui";
import { useEffect } from "react";
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
              <h1 className={styles.title}>{ERROR_COPY.title}</h1>
              <p className={styles.body}>{ERROR_COPY.body}</p>
            </div>
            <div className={actions.actions}>
              <Button variant="accent" shape="pill" onClick={() => retry()}>
                {ERROR_COPY.retry}
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
