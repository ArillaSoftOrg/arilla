"use client";

import { useEffect } from "react";
import { trackEvent } from "../../lib/track-event.ts";

export interface ProductAnalyticsProps {
  /** Kalıcı ürün kimliği (productId); fiyat ya da kullanıcıya özel değer değil. */
  itemId: number;
  itemName: string;
  itemCategory?: string | null;
  /** Ürünün birincil teklifinin mağazası; yoksa null. */
  storeName: string | null;
}

/**
 * Karar 0216: `view_item` (sayfa başına bir kez) ve bu sayfadaki `/git/…` mağaza
 * çıkışı bağlantıları için `store_redirect_click`. Çıkış kaydı (`click`, attribution)
 * sunucuda ayrıca yazılır; bu yalnızca tarayıcı ölçümüdür. Görsel çıktısı yok.
 */
export function ProductAnalytics({
  itemId,
  itemName,
  itemCategory,
  storeName,
}: ProductAnalyticsProps) {
  useEffect(() => {
    trackEvent("view_item", {
      item_id: String(itemId),
      item_name: itemName,
      ...(itemCategory ? { item_category: itemCategory } : {}),
      ...(storeName ? { store_name: storeName } : {}),
    });
  }, [itemId, itemName, itemCategory, storeName]);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.button > 1) return;
      const target = event.target instanceof Element ? event.target : null;
      const href = target?.closest("a[href]")?.getAttribute("href") ?? "";
      if (!/^\/git\/\d+\/?(\?|$)/.test(href)) return;
      trackEvent("store_redirect_click", {
        item_id: String(itemId),
        item_name: itemName,
        ...(storeName ? { store_name: storeName } : {}),
      });
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("auxclick", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("auxclick", onClick, true);
    };
  }, [itemId, itemName, storeName]);

  return null;
}
