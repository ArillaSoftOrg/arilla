"use client";

import { useEffect } from "react";
import { SearchErrorState } from "../search-error.tsx";

/** docs/pages.md "/ara" Hata satırının görsel arama karşılığı. */
export default function GorselAramaError({
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
