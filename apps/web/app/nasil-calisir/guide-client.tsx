"use client";

import { Button, VisuallyHidden } from "@arilla/ui";
import { useRef, useState } from "react";
import { GUIDE_STEPS } from "./guide-steps.ts";
import styles from "./page.module.css";

export function HowItWorksGuide() {
  const [activeIndex, setActiveIndex] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const active = GUIDE_STEPS[activeIndex] ?? GUIDE_STEPS[0];
  const number = String(activeIndex + 1).padStart(2, "0");
  const total = String(GUIDE_STEPS.length).padStart(2, "0");

  function showStep(index: number) {
    setActiveIndex(index);
    // Alt kontrollerden geçince yeni açıklama ekranın yukarısında kaybolmasın.
    if (panel.current && panel.current.getBoundingClientRect().top < 0) {
      const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      panel.current.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    }
  }

  return (
    <div className={styles.guide}>
      {/* biome-ignore lint/a11y/noRedundantRoles: list-style:none Safari'de liste rolunu dusurur. */}
      <ol className={styles.steps} aria-label="Örnek aramanın adımları" role="list">
        {GUIDE_STEPS.map((step, index) => (
          <li key={step.id}>
            <button
              type="button"
              id={`adim-${step.id}`}
              className={styles.stepButton}
              aria-pressed={index === activeIndex}
              aria-controls="ornek-ekran"
              onClick={() => showStep(index)}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {String(index + 1).padStart(2, "0")}
              </span>
              {step.title}
            </button>
          </li>
        ))}
      </ol>
      <div id="ornek-ekran" className={styles.guidePanel} ref={panel}>
        <div className={styles.explanation} aria-live="polite" aria-atomic="true">
          <h2 id="ornek-adim-basligi" className={styles.stepTitle}>
            {active.title}
          </h2>
          <p className={styles.description}>{active.description}</p>
          <blockquote className={styles.example}>{active.example}</blockquote>
          {active.id === "butce" ? (
            <p className={styles.filterHint}>
              <strong>Filtreleri düzenle</strong> ile marka, renk, beden ve bütçeyi de
              değiştirebilirsin. Tercihlerin mesaj kutusuna eklenir; gönderdiğinde araman
              güncellenir.
            </p>
          ) : null}
        </div>
        <figure className={styles.figure} aria-labelledby="ornek-adim-basligi">
          <div className={styles.frameLabel}>Gerçek bir aramadan</div>
          <div className={styles.capture}>
            <picture key={active.id}>
              <source
                media="(min-width: 1024px)"
                srcSet={active.desktop.src}
                width={active.desktop.width}
                height={active.desktop.height}
              />
              {/* Web ve mobil ayrı gerçek kayıtlardır; görseller kırpılmaz. */}
              <img
                src={active.mobile.src}
                width={active.mobile.width}
                height={active.mobile.height}
                alt={active.alt}
                className={styles.image}
                decoding="async"
              />
            </picture>
          </div>
          <figcaption className={styles.caption}>
            <span className={styles.mobileOnly}>{active.caption}</span>
            <span className={styles.desktopOnly}>{active.desktopCaption}</span>
            <a
              href={active.mobile.src}
              target="_blank"
              rel="noopener"
              className={styles.mobileOnly}
            >
              Görüntüyü büyüt <span aria-hidden="true">↗</span>
            </a>
            <a
              href={active.desktop.src}
              target="_blank"
              rel="noopener"
              className={styles.desktopOnly}
            >
              Görüntüyü büyüt <span aria-hidden="true">↗</span>
            </a>
          </figcaption>
        </figure>
      </div>
      <nav className={styles.controls} aria-label="Örnek adımlarında gezin">
        <Button
          variant="ghost"
          className={styles.controlButton}
          disabled={activeIndex === 0}
          onClick={() => showStep(Math.max(0, activeIndex - 1))}
        >
          <span aria-hidden="true">←</span> Önceki
        </Button>
        <span className={styles.progress}>
          <span aria-hidden="true">
            {number} / {total}
          </span>
          <VisuallyHidden>
            {`${activeIndex + 1}. adım, toplam ${GUIDE_STEPS.length} adım`}
          </VisuallyHidden>
        </span>
        <Button
          variant="secondary"
          className={styles.controlButton}
          disabled={activeIndex === GUIDE_STEPS.length - 1}
          onClick={() => showStep(Math.min(GUIDE_STEPS.length - 1, activeIndex + 1))}
        >
          Sonraki <span aria-hidden="true">→</span>
        </Button>
      </nav>
    </div>
  );
}
