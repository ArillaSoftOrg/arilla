"use client";

import { useEffect } from "react";
import { SearchErrorState } from "./search-error.tsx";

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

  return <SearchErrorState onRetry={() => retry()} />;
}
