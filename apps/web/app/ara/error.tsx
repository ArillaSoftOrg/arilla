"use client";

import { Button, EmptyState } from "@arilla/ui";
import { useEffect } from "react";

/** docs/pages.md "/ara" Hata satırı: "Arama şu an çalışmıyor" + tekrar dene. */
export default function AramaError({
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
    <main style={{ padding: 24 }}>
      <EmptyState
        title="Arama şu an çalışmıyor. Birazdan tekrar dener misin?"
        action={<Button onClick={() => retry()}>Tekrar dene</Button>}
      />
    </main>
  );
}
