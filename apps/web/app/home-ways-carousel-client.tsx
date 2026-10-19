import { ProductImage } from "@arilla/ui";
import styles from "./home.module.css";

export interface HomeWayCard {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  imageAlt: string;
  tone: "aqua" | "mist" | "warm";
  mode: "image" | "link" | "chat" | "compare";
  mockImageUrl?: string;
}

export function HomeWaysCarousel({
  title,
  items,
}: {
  title: string;
  items: readonly HomeWayCard[];
}) {
  return (
    <div className={styles.ways}>
      <div className={styles.waysHeader}>
        <h2 id="nasil-calisir-baslik" className={styles.waysTitle}>
          {title}
        </h2>
      </div>

      {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none WebKit'te liste rolunu dusurur. */}
      <ul role="list" className={styles.waysTrack}>
        {items.map((item, index) => (
          <li key={item.id} className={styles.wayItem}>
            <article className={`${styles.wayCard} ${styles[`wayCard_${item.tone}`]}`}>
              <div className={styles.wayVisual}>
                <ProductImage
                  src={item.mockImageUrl ?? item.imageUrl}
                  alt=""
                  className={styles.wayMockImage}
                  fit="cover"
                />
              </div>
              <div className={styles.wayBody}>
                <span className={styles.wayNumber} aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <h3 className={styles.wayCaption}>{item.title}</h3>
                <p className={styles.wayDescription}>{item.description}</p>
              </div>
            </article>
          </li>
        ))}
      </ul>
    </div>
  );
}
