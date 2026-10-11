"use client";

import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import styles from "./coming-soon.module.css";
import { COMING_SOON_COPY } from "./coming-soon-copy.ts";
import { useNeedsConsentPrompt } from "./cookie-consent-client.tsx";
import { type MascotStop, mascotPoseAt } from "./mascot-journey-motion.ts";
import { MascotPortrait } from "./mascot-portrait.tsx";

export function MascotJourney({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const actorRef = useRef<HTMLDivElement>(null);
  const greetedRef = useRef(false);
  const [allowsMotion, setAllowsMotion] = useState<boolean | null>(null);
  const [wideScreen, setWideScreen] = useState(false);
  const [paused, setPaused] = useState(false);
  const toggleId = useId();
  const needsConsent = useNeedsConsentPrompt();
  const moving = allowsMotion === true && !paused;
  const greetingReady = wideScreen || !needsConsent;

  useEffect(() => {
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const viewport = window.matchMedia("(min-width: 1024px)");
    const update = () => {
      setAllowsMotion(!preference.matches);
      setWideScreen(viewport.matches);
    };
    update();
    preference.addEventListener("change", update);
    viewport.addEventListener("change", update);
    return () => {
      preference.removeEventListener("change", update);
      viewport.removeEventListener("change", update);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    if (!root || !moving || !greetingReady || greetedRef.current || window.scrollY > 40) return;
    let disposed = false;
    const timers: number[] = [];
    const animations: Animation[] = [];
    const portraits = [root.querySelector("[data-mascot-stop]"), actorRef.current];
    const images = portraits.flatMap((portrait) => [...(portrait?.querySelectorAll("img") ?? [])]);

    // Start only when both pieces are decoded; a failed image keeps the static fallback.
    Promise.all(images.map((image) => image.decode()))
      .then(() => {
        if (disposed || window.scrollY > 40) return;
        greetedRef.current = true;
        root.dataset.waving = "true";
        root.dataset.greeting = "wave";
        for (const portrait of portraits) {
          const arm = portrait?.querySelector("[data-mascot-arm]");
          if (arm)
            animations.push(
              arm.animate(
                [
                  { transform: "rotate(0deg)", offset: 0 },
                  { transform: "rotate(88deg)", offset: 0.24 },
                  { transform: "rotate(62deg)", offset: 0.38 },
                  { transform: "rotate(96deg)", offset: 0.52 },
                  { transform: "rotate(62deg)", offset: 0.66 },
                  { transform: "rotate(88deg)", offset: 0.78 },
                  { transform: "rotate(0deg)", offset: 1 },
                ],
                { duration: 2400, easing: "ease-in-out" },
              ),
            );
        }
        timers.push(
          window.setTimeout(() => {
            root.dataset.greeting = "introduction";
          }, 800),
        );
        timers.push(
          window.setTimeout(() => {
            delete root.dataset.waving;
          }, 2400),
        );
        timers.push(
          window.setTimeout(() => {
            root.dataset.greeting = "invitation";
          }, 4400),
        );
      })
      .catch(() => {
        /* The full, unsplit image remains the fallback. */
      });

    return () => {
      disposed = true;
      for (const timer of timers) window.clearTimeout(timer);
      for (const animation of animations) animation.cancel();
      delete root.dataset.waving;
      delete root.dataset.greeting;
    };
  }, [moving, greetingReady]);

  useEffect(() => {
    const root = rootRef.current;
    const actor = actorRef.current;
    if (!root || !actor || !moving) return;

    const anchors = [...root.querySelectorAll<HTMLElement>("[data-mascot-stop]")];
    if (anchors.length < 2) return;

    // Narrow screens keep the character in its own space, away from reading text.
    if (!wideScreen) {
      const animations: Animation[] = [];
      const entrances = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const image = entry.target.querySelector<HTMLElement>(`.${styles.mascotPortrait}`);
            if (image)
              animations.push(
                image.animate(
                  [
                    { transform: "translateY(18px) rotate(-4deg)" },
                    { transform: "translateY(-8px) rotate(2deg)", offset: 0.6 },
                    { transform: "translateY(0) rotate(0)" },
                  ],
                  { duration: 700, easing: "ease-out" },
                ),
              );
            entrances.unobserve(entry.target);
          }
        },
        { threshold: 0.5 },
      );
      for (const anchor of anchors.slice(1)) entrances.observe(anchor);
      return () => {
        entrances.disconnect();
        for (const animation of animations) animation.cancel();
      };
    }

    let stops: MascotStop[] = [];
    let frame = 0;
    let needsMeasure = true;
    let disposed = false;

    const draw = () => {
      frame = 0;
      if (needsMeasure) {
        const bounds = root.getBoundingClientRect();
        stops = anchors.map((anchor, index) => {
          const rect = anchor.getBoundingClientRect();
          return {
            x: rect.left - bounds.left,
            y: rect.top - bounds.top,
            size: rect.width,
            scroll:
              index === 0
                ? 0
                : Math.max(1, rect.top + window.scrollY - (window.innerHeight - rect.height) / 2),
          };
        });
        needsMeasure = false;
      }
      const pose = mascotPoseAt(stops, window.scrollY);
      actor.style.transform = `translate3d(${pose.x}px, ${pose.y}px, 0) scale(${pose.size / 340}) rotate(${pose.rotation}deg)`;
      root.dataset.moving = "true";
    };

    const schedule = () => {
      if (!frame && !disposed) frame = window.requestAnimationFrame(draw);
    };
    const measure = () => {
      needsMeasure = true;
      schedule();
    };

    const observer = new ResizeObserver(measure);
    observer.observe(root);
    for (const anchor of anchors) observer.observe(anchor);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", measure);
    document.fonts.ready.then(() => {
      if (!disposed) measure();
    });
    draw();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", measure);
      observer.disconnect();
      delete root.dataset.moving;
    };
  }, [moving, wideScreen]);

  return (
    <div ref={rootRef} className={styles.journey}>
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
      <div ref={actorRef} className={styles.travellingMascot} aria-hidden="true">
        <MascotPortrait first />
      </div>
    </div>
  );
}
