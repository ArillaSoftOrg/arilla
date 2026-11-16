"use client";

import { Section } from "@arilla/ui";
import { useEffect } from "react";
import { ErrorView, publicErrorFromBoundary } from "../error-view.tsx";
import { HOME_COPY } from "../home-copy.ts";
import { HomeSectionHeading } from "../home-section-heading.tsx";
import styles from "./discover.module.css";
import kesfet from "./kesfet.module.css";

/** Keşfet hata durumu: kabuk ve başlık yerinde kalır, ortak ErrorView (karar 0104) gösterilir. */
export default function KesfetError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    // Hata nesnesi/yığını konsola yazılmaz: yalnız sınıf ve opak digest.
    console.error("[kesfet] error", error.name, error.digest ?? "");
  }, [error]);

  return (
    <div className={kesfet.page}>
      <Section aria-labelledby="kesfet-baslik">
        <HomeSectionHeading
          id="kesfet-baslik"
          level={1}
          title={HOME_COPY.navDiscover}
          description={HOME_COPY.kesfetDescription}
        />
        <ErrorView
          error={publicErrorFromBoundary(error)}
          onRetry={() => retry()}
          className={styles.errorBox}
        />
      </Section>
    </div>
  );
}
