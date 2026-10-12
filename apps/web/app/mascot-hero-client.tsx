"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import styles from "./coming-soon.module.css";

export function MascotJourney({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [allowsMotion, setAllowsMotion] = useState<boolean | null>(null);
  const moving = allowsMotion === true;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setAllowsMotion(!preference.matches);
    };
    update();
    preference.addEventListener("change", update);
    return () => {
      preference.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !moving) return;
    const guides = [
      ...root.querySelectorAll<HTMLElement>('[data-mascot-guide]:not([data-pose="welcome"])'),
    ];

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const guide = entry.target as HTMLElement;
          const stage = guide.closest<HTMLElement>("[data-guide-stage]");
          if (entry.isIntersecting) {
            guide.dataset.inView = "true";
            if (stage) stage.dataset.inView = "true";
          } else {
            delete guide.dataset.inView;
            if (stage) delete stage.dataset.inView;
          }
        }
      },
      { rootMargin: "0px 0px -12%", threshold: 0.3 },
    );
    for (const guide of guides) observer.observe(guide);

    return () => {
      observer.disconnect();
      for (const guide of guides) {
        delete guide.dataset.inView;
        const stage = guide.closest<HTMLElement>("[data-guide-stage]");
        if (stage) delete stage.dataset.inView;
      }
    };
  }, [moving]);

  return (
    <div ref={rootRef} className={styles.journey} data-motion={moving ? "true" : "false"}>
      {children}
    </div>
  );
}
