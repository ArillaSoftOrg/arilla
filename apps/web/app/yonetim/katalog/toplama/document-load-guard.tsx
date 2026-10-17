"use client";

import { useEffect } from "react";
import { needsReloadForCollection } from "./document-load.ts";

/**
 * Panel icinden istemci gecisiyle gelindiyse sayfayi bir kez tam yukler; boylece bu yolun
 * CSP basligi (kaynak magazaya `connect-src`) uygulanir. Yeniden yuklenen belgenin gezinme
 * kaydi bu yolu gosterdigi icin dongu olusmaz.
 */
export function DocumentLoadGuard() {
  useEffect(() => {
    const [nav] = performance.getEntriesByType("navigation");
    if (needsReloadForCollection(nav?.name)) window.location.reload();
  }, []);
  return null;
}
