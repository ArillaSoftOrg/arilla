"use client";

import { CloseIcon, SearchComposer, type SearchComposerAttachment } from "@arilla/ui";
import { type FocusEvent, type RefObject, useEffect, useRef, useState } from "react";
import { useConsentBannerVisible } from "./cookie-consent-client.tsx";
import styles from "./floating-composer.module.css";
import {
  initialScrollTrack,
  isFloatingVisible,
  resetScrollTrack,
  type ScrollTrack,
  trackScroll,
} from "./floating-composer-state.ts";
import { HOME_COPY } from "./home-copy.ts";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function mainBox(wrapper: HTMLElement | null): HTMLElement | null {
  return wrapper?.querySelector("search") ?? wrapper;
}

/**
 * Karar 0093: ana kutu ekrandan cikinca beliren yuzen hizli arama. Gonderim ana
 * kutuyla AYNI (cagiran ayni `useHomeComposerSubmission` ornegini verir); burada
 * yalnizca gorunurluk, "+" (ana kutuya git) ve kapatma vardir.
 */
export function FloatingHomeComposer({
  mainRef,
  mainPhotoButtonId,
  action,
  onSubmitText,
  attachment,
  statusMessage,
  showAttach,
}: {
  /** Ana kutunun sarmalayicisi: gorunurlugu IntersectionObserver ile izlenir. */
  mainRef: RefObject<HTMLElement | null>;
  /** "+" odagi tasir; ana kutunun fotograf dugmesi. */
  mainPhotoButtonId: string;
  action?: (formData: FormData) => void | Promise<void>;
  onSubmitText?: (text: string) => boolean | Promise<boolean>;
  attachment: SearchComposerAttachment | null;
  statusMessage: string | null;
  /** Fotograf eki acik mi ("+" yalnizca o zaman). */
  showAttach: boolean;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<ScrollTrack | null>(null);
  const [mainVisible, setMainVisible] = useState(true);
  const [scrollShown, setScrollShown] = useState(false);
  const [focused, setFocused] = useState(false);
  // Sayfa omru boyunca; yenileme/gezinme sifirlar (depolama yok).
  const [dismissed, setDismissed] = useState(false);
  const bannerVisible = useConsentBannerVisible();

  // Ana kutu gorunur mu? Gorununce kaydirma durumu sifirlanir (tekrar asagi kaydirma gerekir).
  // Yalnizca kutunun kendisi (`<search>`) sayilir; altindaki "son bakilanlar" satiri degil.
  useEffect(() => {
    const target = mainBox(mainRef.current);
    if (!target || dismissed) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        setMainVisible(visible);
        if (visible && trackRef.current) {
          trackRef.current = resetScrollTrack(trackRef.current);
          setScrollShown(false);
        }
      },
      { threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [mainRef, dismissed]);

  // Yon: pasif dinleyici, kare basina en fazla bir okuma; durum yalnizca degisince yazilir.
  useEffect(() => {
    if (dismissed) return;
    trackRef.current = initialScrollTrack(window.scrollY);
    let frame = 0;
    function update() {
      frame = 0;
      const previous = trackRef.current ?? initialScrollTrack(window.scrollY);
      const maxY = document.documentElement.scrollHeight - window.innerHeight;
      const next = trackScroll(previous, window.scrollY, maxY);
      trackRef.current = next;
      if (next.shown !== previous.shown) setScrollShown(next.shown);
    }
    function onScroll() {
      if (frame === 0) frame = window.requestAnimationFrame(update);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [dismissed]);

  const visible = isFloatingVisible({
    scrollShown,
    mainVisible,
    dismissed,
    bannerVisible,
    focused,
  });

  function onFocusCapture() {
    setFocused(true);
  }

  function onBlurCapture(event: FocusEvent<HTMLDivElement>) {
    const next = event.relatedTarget as Node | null;
    if (!next || !wrapperRef.current?.contains(next)) setFocused(false);
  }

  function goToMainForPhoto() {
    const reduced = window.matchMedia(REDUCED_MOTION).matches;
    mainBox(mainRef.current)?.scrollIntoView({
      block: "center",
      behavior: reduced ? "auto" : "smooth",
    });
    document.getElementById(mainPhotoButtonId)?.focus({ preventScroll: true });
  }

  function dismiss() {
    const hadFocus = wrapperRef.current?.contains(document.activeElement) ?? false;
    setFocused(false);
    setDismissed(true);
    // Odak gizlenen kutuda kalmasin: ana icerige (SkipLink hedefi), kaydirmadan.
    if (hadFocus) document.getElementById("icerik")?.focus({ preventScroll: true });
  }

  return (
    <div
      ref={wrapperRef}
      className={styles.layer}
      data-visible={visible ? "true" : "false"}
      aria-hidden={visible ? undefined : true}
      inert={!visible}
      onFocusCapture={onFocusCapture}
      onBlurCapture={onBlurCapture}
    >
      <div className={styles.dock}>
        <div className={styles.composer}>
          <SearchComposer
            variant="mini"
            landmarkLabel={HOME_COPY.quickSearchLabel}
            action={action}
            onSubmitText={onSubmitText}
            placeholder={HOME_COPY.searchPlaceholder}
            inputLabel={HOME_COPY.searchInputLabel}
            submitLabel={HOME_COPY.searchSubmitLabel}
            routeProductLinks
            statusMessage={statusMessage}
            announce={false}
            attachment={attachment}
            leadingAction={
              showAttach
                ? { label: HOME_COPY.quickSearchAttachLabel, onClick: goToMainForPhoto }
                : undefined
            }
          />
        </div>
        <button
          type="button"
          className={styles.dismiss}
          aria-label={HOME_COPY.quickSearchDismissLabel}
          onClick={dismiss}
        >
          <CloseIcon />
        </button>
      </div>
    </div>
  );
}
