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
    // Hata nesnesi/yigini tarayici konsoluna yazilmaz: yalnizca sinif ve Next'in
    // opak `digest`'i (sunucu logundaki kayitla eslemek icin).
    console.error("[ara] search error", error.name, error.digest ?? "");
  }, [error]);

  return <SearchErrorState onRetry={() => retry()} />;
}
