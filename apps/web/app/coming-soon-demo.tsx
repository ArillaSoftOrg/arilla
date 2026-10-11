"use client";

import { ImageIcon, LinkIcon, SearchIcon } from "@arilla/ui";
import { useEffect, useRef, useState } from "react";
import styles from "./coming-soon.module.css";
import { COMING_SOON_COPY as copy } from "./coming-soon-copy.ts";

const FINAL_PHASE = 4;

function storyPhase(progress: number): number {
  if (progress < 0.14) return 0;
  if (progress < 0.34) return 1;
  if (progress < 0.56) return 2;
  if (progress < 0.8) return 3;
  return FINAL_PHASE;
}

export function ComingSoonDemo() {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState(FINAL_PHASE);

  useEffect(() => {
    const scrollRegion = scrollRef.current;
    if (!scrollRegion) return;

    const journey = scrollRegion.closest<HTMLElement>("[data-motion]");
    let animationFrame = 0;

    const update = () => {
      animationFrame = 0;
      if (journey?.dataset.motion !== "true") {
        setPhase(FINAL_PHASE);
        return;
      }

      const rect = scrollRegion.getBoundingClientRect();
      const stickyOffset = window.innerWidth < 640 ? 56 : 72;
      const travel = Math.max(1, rect.height - window.innerHeight + stickyOffset);
      const progress = Math.min(1, Math.max(0, (stickyOffset - rect.top) / travel));
      setPhase(storyPhase(progress));
    };

    const scheduleUpdate = () => {
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(update);
    };

    const motionObserver = journey ? new MutationObserver(scheduleUpdate) : null;
    motionObserver?.observe(journey as HTMLElement, {
      attributes: true,
      attributeFilter: ["data-motion"],
    });
    window.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    update();

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      motionObserver?.disconnect();
      window.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, []);

  return (
    <section id="nasil-calisacak" className={styles.demo} aria-labelledby="demo-baslik">
      <header className={styles.demoHeader}>
        <p className={styles.chapter}>
          <span>01</span>
          {copy.demoEyebrow}
        </p>
        <h2 id="demo-baslik" className={styles.demoTitle}>
          {copy.demoTitle}
        </h2>
        <p className={styles.demoLead}>{copy.demoBody}</p>
        <p className={styles.demoInstruction}>{copy.demoInstruction}</p>
      </header>

      <div ref={scrollRef} className={styles.demoScroll}>
        <div className={styles.demoSticky} data-phase={phase}>
          <div className={styles.demoStage}>
            <div className={styles.demoWorkspace}>
              <div className={styles.demoStageTop}>
                <span className={styles.demoBadge}>{copy.demoNotice}</span>
                <div className={styles.demoInputModes}>
                  <span>
                    <SearchIcon size={16} />
                    {copy.demoModes.describe}
                  </span>
                  <span>
                    <ImageIcon size={16} />
                    {copy.demoModes.photo}
                  </span>
                  <span>
                    <LinkIcon size={16} />
                    {copy.demoModes.link}
                  </span>
                </div>
              </div>

              <div className={styles.demoChat}>
                <article className={`${styles.demoMessage} ${styles.demoUserMessage}`}>
                  <span className={styles.demoMessageLabel}>{copy.demoUserLabel}</span>
                  <p>{copy.demoUserMessage}</p>
                </article>
                <article className={`${styles.demoMessage} ${styles.demoAssistantMessage}`}>
                  <span className={styles.demoMessageLabel}>{copy.demoAssistantLabel}</span>
                  <p>{copy.demoAssistantMessage}</p>
                </article>
              </div>

              <div className={styles.demoProductGrid}>
                {copy.demoProductInsights.map((product, index) => (
                  <figure
                    key={product.title}
                    className={styles.demoProduct}
                    data-selected={index === 1 ? "true" : undefined}
                  >
                    <div
                      className={styles.demoProductImage}
                      data-product={index + 1}
                      role="img"
                      aria-label={`${product.title} için markasız temsili ayakkabı görseli`}
                    />
                    <figcaption>
                      <strong className={styles.demoProductTitle}>{product.title}</strong>
                      <span className={styles.demoProductNote}>{product.note}</span>
                    </figcaption>
                    {index === 1 ? (
                      <span className={styles.demoWinner}>{copy.demoWinner}</span>
                    ) : null}
                  </figure>
                ))}
              </div>

              <div className={styles.demoComposer} aria-hidden="true">
                <SearchIcon size={18} />
                <span className={styles.demoComposerPlaceholder}>
                  {copy.demoComposerPlaceholder}
                </span>
                <ImageIcon size={17} />
                <LinkIcon size={17} />
              </div>
            </div>

            <aside className={styles.demoRobotStage} aria-label="ManiCepte rehberi">
              <div className={styles.demoRobotSprite} aria-hidden="true" />
              <p className={styles.demoRobotStatus} aria-live="polite">
                {copy.demoPhaseLabels[phase] ?? copy.demoPhaseLabels[FINAL_PHASE]}
              </p>
            </aside>
          </div>

          <ol className={styles.demoTimeline} aria-label="ManiCepte ürün araştırma akışı">
            {copy.demoScrollSteps.map((step, index) => (
              <li
                key={step}
                data-active={phase >= index + 1 ? "true" : undefined}
                data-current={phase === index + 1 ? "true" : undefined}
              >
                <span className={styles.demoTimelineNumber}>
                  {String(index + 1).padStart(2, "0")}
                </span>
                {step}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
