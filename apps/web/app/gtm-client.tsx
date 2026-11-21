"use client";

import { CLARITY_SCRIPT_ORIGIN, consentModeState, GTM_SCRIPT_ORIGIN } from "@arilla/core/gtm";
import { useEffect } from "react";

/**
 * Consent Mode v2 senkronu (karar 0219). İlk varsayılan ve önceki tercih `<head>`
 * betiğiyle GTM'den ÖNCE uygulanır; bu bileşen rıza sonradan değişince
 * (banner, panel, /cerez) `consent update` gönderir. Reklam sinyalleri kalıcı denied.
 */
export function GtmConsentSync({ analyticsGranted }: { analyticsGranted: boolean }) {
  useEffect(() => {
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer ?? [];
    // Resmi gtag deseni: `arguments` nesnesi push edilir (dizi değil).
    (function gtag(..._args: unknown[]) {
      // biome-ignore lint/complexity/noArguments: gtag/GTM `arguments` nesnesi bekler.
      w.dataLayer?.push(arguments);
    })("consent", "update", consentModeState(analyticsGranted));
  }, [analyticsGranted]);
  return null;
}

/**
 * `GTM_LOAD_BEFORE_CONSENT=false` (karar 0219): GTM yalnızca analitik rızasından sonra,
 * `<ConsentGate>` içinde yüklenir. Yönetim alanında yüklenmez. Rıza geri alınırsa
 * `GtmConsentSync` denied gönderir; yüklenmiş kapsayıcı oturum sonuna kadar kalır.
 */
export function GtmLateLoader({ gtmId }: { gtmId: string }) {
  useEffect(() => {
    if (window.location.pathname.startsWith("/yonetim")) return;
    if (document.querySelector('script[src*="googletagmanager.com/gtm.js"]')) return;
    const w = window as unknown as { dataLayer?: unknown[] };
    w.dataLayer = w.dataLayer ?? [];
    w.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
    const script = document.createElement("script");
    script.async = true;
    script.src = `${GTM_SCRIPT_ORIGIN}/gtm.js?id=${encodeURIComponent(gtmId)}`;
    document.head.appendChild(script);
  }, [gtmId]);
  return null;
}

type ClarityFn = (...args: unknown[]) => void;

/**
 * Microsoft Clarity (karar 0219). YALNIZCA `<ConsentGate category="analytics">` içinde
 * render edilir: bu bileşen var olduğu sürece analitik rızası vardır, onaydan önce betik
 * hiç yüklenmez. Clarity Consent API v2: rıza verilince `consentv2` granted; sökülünce
 * (rıza geri alındı) denied -> Clarity çerezlerini kapatır. Maskeleme (Katı) panelde;
 * kodda ayrıca `data-clarity-mask="True"` ile alan bazlı maskelenir.
 */
export function ClarityClient({ projectId }: { projectId: string }) {
  useEffect(() => {
    const w = window as unknown as { clarity?: ClarityFn };
    if (!w.clarity) {
      // Resmi snippet'in eşdeğeri (CSP `unsafe-eval` vermez): kuyruk + betik etiketi.
      const queue: ClarityFn & { q?: unknown[] } = function clarityQueue(...args: unknown[]) {
        queue.q = queue.q ?? [];
        queue.q.push(args);
      };
      w.clarity = queue;
      const script = document.createElement("script");
      script.async = true;
      script.src = `${CLARITY_SCRIPT_ORIGIN}/tag/${encodeURIComponent(projectId)}`;
      document.head.appendChild(script);
    }
    w.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "granted" });
    return () => {
      w.clarity?.("consentv2", { ad_Storage: "denied", analytics_Storage: "denied" });
    };
  }, [projectId]);
  return null;
}
