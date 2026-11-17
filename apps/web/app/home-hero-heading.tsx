"use client";

import { type HomeCategoryId, HomeCategoryPicker } from "./home-category-picker-client.tsx";
import { HOME_COPY } from "./home-copy.ts";
import styles from "./home-search-composer.module.css";

/**
 * Ana sayfa hero başlığı: "[Kategori] için ne arıyorsun?". Kategori adı başlığın içinde altı çizili,
 * tıklanabilir açılır listedir (mevcut `HomeCategoryPicker`); seçim üst bileşendeki kategori durumunu
 * değiştirir, böylece başlık, hero görseli ve öneri etiketleri birlikte güncellenir.
 */
export function HomeHeroHeading({
  value,
  onChange,
}: {
  value: HomeCategoryId;
  onChange: (value: HomeCategoryId) => void;
}) {
  return (
    <h1 id="anasayfa-baslik" className={styles.heroTitle}>
      <HomeCategoryPicker value={value} onChange={onChange} />{" "}
      <span className={styles.heroTitleSuffix}>{HOME_COPY.heroTitleSuffix}</span>
    </h1>
  );
}
