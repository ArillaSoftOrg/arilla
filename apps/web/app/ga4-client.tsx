"use client";

import {
  GA4_CONSENT_DENIED,
  GA4_CONSENT_GRANTED,
  GA4_SCRIPT_ORIGIN,
  ga4ConfigParams,
  ga4CookieNames,
  ga4DisableKey,
  sanitizePage,
  sanitizeReferrer,
} from "@arilla/core/ga4-measurement";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

type Gtag = (...args: unknown[]) => void;

interface Ga4Window {
  dataLayer?: unknown[];
  gtag?: Gtag;
  [key: string]: unknown;
}

const SCRIPT_ID = "ga4-gtag";

function ga4Window(): Ga4Window {
  return window as unknown as Ga4Window;
}

/** gtag kuyruğu: betik yüklenmeden çağrılar `dataLayer`'da bekler (resmi desen). */
function ensureGtag(): Gtag {
  const w = ga4Window();
  w.dataLayer = w.dataLayer ?? [];
  if (!w.gtag) {
    w.gtag = function gtag() {
      // biome-ignore lint/complexity/noArguments: gtag.js `arguments` nesnesi bekler.
      (w.dataLayer as unknown[]).push(arguments);
    };
  }
  return w.gtag;
}

/** Host'a özel GA4 çerezlerini siler (rıza geri alınınca, sunucuyla birlikte). */
export function deleteGa4Cookies(measurementId: string, doc: Document = document): void {
  for (const name of ga4CookieNames(measurementId)) {
    doc.cookie = `${name}=; Max-Age=0; path=/; SameSite=Lax`;
  }
}

/**
 * GA4 (karar 0087). YALNIZCA `<ConsentGate category="analytics">` içinde
 * render edilir: bu bileşen var olduğu sürece rıza vardır. Sökülünce (rıza
 * geri alındı) ölçüm anında durur ve çerezler silinir.
 *
 * Gönderilen tek olay `page_view`; adres, yönlendiren ve başlık
 * `@arilla/core/ga4-measurement` ile arındırılır. Ölçülmeyen yollarda
 * (`/yonetim`, auth alt yolları...) betik hiç yüklenmez; yüklendiyse kapatılır.
 */
export function Ga4Client({ measurementId }: { measurementId: string }) {
  const pathname = usePathname();
  const configured = useRef(false);
  const lastSent = useRef<string | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rota değişimi tetikleyicidir; adres UTM için window.location'dan okunur.
  useEffect(() => {
    const w = ga4Window();
    const origin = window.location.origin;
    const page = sanitizePage(window.location.href, origin);
    // Ölçülmeyen yol: varsa ölçüm durdurulur, betik yüklenmez.
    w[ga4DisableKey(measurementId)] = page === null;
    if (page === null) return;

    const gtag = ensureGtag();
    if (!configured.current) {
      configured.current = true;
      gtag("consent", "default", GA4_CONSENT_GRANTED);
      gtag("consent", "update", GA4_CONSENT_GRANTED);
      gtag("js", new Date());
      gtag("config", measurementId, ga4ConfigParams(window.location.protocol === "https:"));
      if (!document.getElementById(SCRIPT_ID)) {
        const script = document.createElement("script");
        script.id = SCRIPT_ID;
        script.async = true;
        script.src = `${GA4_SCRIPT_ORIGIN}/gtag/js?id=${encodeURIComponent(measurementId)}`;
        document.head.appendChild(script);
      }
    }
    if (lastSent.current === page.location) return;
    const referrer = lastSent.current ?? sanitizeReferrer(document.referrer, origin);
    lastSent.current = page.location;
    // `set`: aynı sayfadaki otomatik isabetler de (oturum başlangıcı vb.)
    // ham adres yerine arındırılmış değerleri taşır.
    gtag("set", {
      page_location: page.location,
      page_referrer: referrer,
      page_title: page.title,
    });
    gtag("event", "page_view", {
      page_location: page.location,
      page_referrer: referrer,
      page_title: page.title,
    });
  }, [measurementId, pathname]);

  useEffect(() => {
    return () => {
      const w = ga4Window();
      w[ga4DisableKey(measurementId)] = true;
      w.gtag?.("consent", "update", GA4_CONSENT_DENIED);
      deleteGa4Cookies(measurementId);
    };
  }, [measurementId]);

  return null;
}
