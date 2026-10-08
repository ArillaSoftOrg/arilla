import type { Metadata } from "next";
import { Suspense } from "react";
import { requireProductAccess } from "../lib/dal.ts";
import { TREND_COPY } from "./trend-copy.ts";
import { TrendlerSkeleton } from "./trend-skeleton.tsx";
import { TrendlerContent } from "./trendler-content.tsx";

export const metadata: Metadata = {
  title: TREND_COPY.metaTitle,
  description: TREND_COPY.metaDescription,
  alternates: { canonical: "/trendler" },
};

/**
 * `/trendler`: editoryal urun kesfi koleksiyonlari (karar 0077). Blog degil.
 * Kesitler: Öne Çıkanlar, Şu An Trend, konu gruplari, Sezonluk; hepsi
 * `Tüm Trendler` altinda. Istek yolu yalnizca okur - baglari `curate` isi
 * yazar; ilk gorunum 50 karti yigmaz (kesit basina sinirli kart).
 */
export default async function TrendlerPage() {
  await requireProductAccess();
  return (
    <Suspense fallback={<TrendlerSkeleton />}>
      <TrendlerContent />
    </Suspense>
  );
}
