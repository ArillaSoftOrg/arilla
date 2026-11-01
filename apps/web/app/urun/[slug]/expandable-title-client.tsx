"use client";

import { useEffect, useId, useRef, useState } from "react";
import styles from "./product-page.module.css";

/**
 * Ürün başlığı (karar 0168): uzun başlık başlangıçta en çok 3 satır gösterilir, "Tamamını
 * göster" ile açılır. Başlığın TAMAMI DOM'dadır (yalnızca CSS ile kırpılır): SEO, ekran
 * okuyucu ve yapılandırılmış veri etkilenmez, veritabanındaki başlık değişmez.
 */
export function ExpandableTitle({ title }: { title: string }) {
  const [expanded, setExpanded] = useState(false);
  // İlk çizimde uzunluk tahmini; istemcide gerçek taşma ölçülür.
  const [overflows, setOverflows] = useState(title.length > 90);
  const ref = useRef<HTMLHeadingElement | null>(null);
  const id = useId();

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      if (expanded) return;
      setOverflows(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [expanded]);

  return (
    <>
      <h1
        id={id}
        ref={ref}
        className={expanded ? styles.title : `${styles.title} ${styles.titleClamped}`}
      >
        {title}
      </h1>
      {overflows || expanded ? (
        <button
          type="button"
          className={styles.titleToggle}
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "Daha az göster" : "Tamamını göster"}
        </button>
      ) : null}
    </>
  );
}
