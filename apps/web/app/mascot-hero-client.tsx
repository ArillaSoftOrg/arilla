"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import styles from "./coming-soon.module.css";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";

type GreetingPhase = "introduction" | "invitation";

export function MascotJourney({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const greetedRef = useRef(false);
  const [allowsMotion, setAllowsMotion] = useState<boolean | null>(null);
  const [paused, setPaused] = useState(false);
  const [greeting, setGreeting] = useState<GreetingPhase>("introduction");
  const toggleId = useId();
  const moving = allowsMotion === true && !paused;

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
    if (!moving || greetedRef.current || window.scrollY > 40) return;
    greetedRef.current = true;
    const timer = window.setTimeout(() => setGreeting("invitation"), 4200);
    return () => window.clearTimeout(timer);
  }, [moving]);

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
    <div
      ref={rootRef}
      className={styles.journey}
      data-motion={moving ? "true" : "false"}
      data-greeting={greeting}
    >
      <label className={styles.motionControl} htmlFor={toggleId}>
        <input
          id={toggleId}
          type="checkbox"
          checked={moving}
          disabled={allowsMotion !== true}
          onChange={(event) => setPaused(!event.currentTarget.checked)}
        />
        {COMING_SOON_COPY.motionLabel}
      </label>
      {children}
    </div>
  );
}
