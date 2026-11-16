import { type DiscoveryItem, EmptyState, Section } from "@arilla/ui";
import { HOME_COPY } from "../home-copy.ts";
import { HomeSectionHeading } from "../home-section-heading.tsx";
import actions from "../public-actions.module.css";
import { dedupeDiscoveryItems } from "./dedupe-discovery.ts";
import { DiscoverCard } from "./discover-card.tsx";
import { DiscoverMasonry } from "./discover-masonry.tsx";
import styles from "./kesfet.module.css";

/** İlk satır (4 sütun) LCP için eager; gerisi lazy. */
const PRIORITY_COUNT = 4;

function Grid({ items, labelledBy }: { items: readonly DiscoveryItem[]; labelledBy: string }) {
  return (
    <DiscoverMasonry labelledBy={labelledBy}>
      {items.map((item, index) => (
        <DiscoverCard key={item.id} item={item} priority={index < PRIORITY_COUNT} />
      ))}
    </DiscoverMasonry>
  );
}

export function KesfetView({
  curated: curatedInput,
  organic: organicInput,
}: {
  curated: readonly DiscoveryItem[];
  organic: readonly DiscoveryItem[];
}) {
  const { curated, organic } = dedupeDiscoveryItems(curatedInput, organicInput);
  if (curated.length === 0 && organic.length === 0) {
    return (
      <Section className={styles.page} aria-labelledby="kesfet-baslik">
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
        {curated.length > 0 ? <Grid items={curated} labelledBy="kesfet-baslik" /> : null}
      </Section>

      {organic.length > 0 ? (
        <Section aria-labelledby="kesfet-organik-baslik">
          <HomeSectionHeading id="kesfet-organik-baslik" title={HOME_COPY.kesfetOrganicTitle} />
          <Grid items={organic} labelledBy="kesfet-organik-baslik" />
        </Section>
      ) : null}
    </div>
  );
}
