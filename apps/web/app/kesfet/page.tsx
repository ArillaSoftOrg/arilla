import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import type { Metadata } from "next";
import { toDiscoveryItems } from "../discovery-adapter.ts";
import { HOME_COPY } from "../home-copy.ts";
import { requireProductAccess } from "../lib/dal.ts";
import { KesfetView } from "./kesfet-view.tsx";

export const metadata: Metadata = {
  title: "Keşfet – Arilla",
  description: HOME_COPY.kesfetDescription,
  alternates: { canonical: "/kesfet" },
};

/**
 * docs/pages.md "/kesfet": "Bugün öne çıkanlar" (curated) -> "Kullanıcıların
 * bulduğu" (organic, yalnızca kayıt varsa) -> creator koleksiyonları.
 * Creator koleksiyonları bölümü burada yok - F bloğu (MVP-2) henüz
 * başlamadı.
 *
 * Ana sayfanın keşif bölümüyle aynı `DiscoveryGrid` + `DiscoveryCard`
 * (tek kart + tek ızgara); satırlar aynı adaptörden (`toDiscoveryItems`)
 * geçer. Burada demo düşüşü YOK - yalnızca gerçek `discovery_slot`.
 * Seçilmiş içerik "Kullanıcıların bulduğu" altında gösterilmez (kural 11).
 */
export default async function KesfetPage() {
  await requireProductAccess();
  const db = getDatabase();
  const items = await getDiscoverySlots(db, todaySlotDate());

  const curated = toDiscoveryItems(items.filter((item) => item.source === "curated"));
  const organic = toDiscoveryItems(items.filter((item) => item.source === "organic"));
  return <KesfetView curated={curated} organic={organic} />;
}
