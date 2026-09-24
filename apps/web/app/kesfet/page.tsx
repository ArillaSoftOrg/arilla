import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { DiscoveryGrid, EmptyState, Section } from "@arilla/ui";
import type { Metadata } from "next";
import { toDiscoveryItems } from "../discovery-adapter.ts";
import { HOME_COPY } from "../home-copy.ts";
import { HomeSectionHeading } from "../home-section-heading.tsx";
import actions from "../public-actions.module.css";
import styles from "./kesfet.module.css";

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
  const db = getDatabase();
  const items = await getDiscoverySlots(db, todaySlotDate());

  const curated = toDiscoveryItems(items.filter((item) => item.source === "curated"));
  const organic = toDiscoveryItems(items.filter((item) => item.source === "organic"));

  if (curated.length === 0 && organic.length === 0) {
    return (
      <Section aria-labelledby="kesfet-baslik">
        <HomeSectionHeading
          id="kesfet-baslik"
          level={1}
          title={HOME_COPY.kesfetCuratedTitle}
          description={HOME_COPY.kesfetDescription}
        />
        <EmptyState
          title={HOME_COPY.kesfetEmptyTitle}
          description={HOME_COPY.kesfetEmptyDescription}
          action={
            <div className={actions.actions}>
              <a href="/" className={actions.primary}>
                {HOME_COPY.kesfetEmptyAction}
              </a>
            </div>
          }
          className={styles.empty}
        />
      </Section>
    );
  }

  return (
    <div className={styles.page}>
      <Section aria-labelledby="kesfet-baslik">
        {/* Secilmis icerik yoksa "Bugün öne çıkanlar" basligi altinda bos
            bir izgara kalmasin; sayfa basligi notr "Keşfet" olur. */}
        <HomeSectionHeading
          id="kesfet-baslik"
          level={1}
          title={curated.length > 0 ? HOME_COPY.kesfetCuratedTitle : HOME_COPY.navDiscover}
          description={HOME_COPY.kesfetDescription}
        />
        {curated.length > 0 ? <DiscoveryGrid items={curated} labelledBy="kesfet-baslik" /> : null}
      </Section>

      {organic.length > 0 ? (
        <Section aria-labelledby="kesfet-organik-baslik">
          <HomeSectionHeading id="kesfet-organik-baslik" title={HOME_COPY.kesfetOrganicTitle} />
          <DiscoveryGrid items={organic} labelledBy="kesfet-organik-baslik" />
        </Section>
      ) : null}
    </div>
  );
}
