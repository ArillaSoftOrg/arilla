"use client";

import { sanitizePage, sanitizeReferrer, sanitizeUtmValue } from "@arilla/core/ga4-measurement";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

/**
 * Umami (karar 0116). YALNIZCA `<ConsentGate category="analytics">` içinde render
 * edilir: bu bileşen var olduğu sürece rıza vardır. Sökülünce (rıza geri alındı)
 * `data-before-send` göndermeyi iptal eder; yeni olay gitmez.
 *
 * Otomatik izleme kapalıdır (`data-auto-track="false"`): tıklama, performans ve
 * otomatik sayfa görüntüleme yok. Tek gönderim noktası bu bileşendir; adres GA4
 * ile AYNI süzgeçten geçer (arındırılmış yol + yalnızca güvenli `utm_*`, başlık
 * yerine yol, dış yönlendiren yalnızca köken). Ölçülmeyen yollarda (`/yonetim`,
 * `/api`, `/giris/*`...) hiçbir şey gönderilmez. `identify` ÇAĞRILMAZ.
 */

type Props = Record<string, unknown>;
interface UmamiApi {
  track: (arg?: ((props: Props) => Props) | string, data?: Record<string, string>) => unknown;
}
interface UmamiWindow {
  umami?: UmamiApi;
  __arillaUmamiEnabled?: boolean;
  __arillaUmamiBeforeSend?: (type: string, payload: unknown) => unknown;
}

const SCRIPT_ID = "umami-tracker";
const CAMPAIGN_KEY = "arilla.utm";
const WAIT_STEP_MS = 250;
const WAIT_MAX_STEPS = 24;

function umamiWindow(): UmamiWindow {
  return window as unknown as UmamiWindow;
}

/** Betik yüklenene kadar bekler (en fazla ~6 sn), sonra bırakır. */
function whenReady(run: (umami: UmamiApi) => void): void {
  let steps = 0;
  const tick = () => {
    const w = umamiWindow();
    if (!w.__arillaUmamiEnabled) return;
    if (w.umami) {
      run(w.umami);
      return;
    }
    if (++steps < WAIT_MAX_STEPS) window.setTimeout(tick, WAIT_STEP_MS);
  };
  tick();
}

/** Aynı sekmede iniş sayfasının güvenli kampanya/kaynak etiketleri (yalnızca iyileştirme). */
export interface LandingCampaign {
  campaign?: string;
  source?: string;
}

export function readLandingCampaign(): LandingCampaign {
  try {
    const raw = window.sessionStorage.getItem(CAMPAIGN_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: LandingCampaign = {};
    for (const key of ["campaign", "source"] as const) {
      const value = parsed[key];
      if (typeof value === "string" && sanitizeUtmValue(value) === value) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

function rememberLandingCampaign(search: URLSearchParams): void {
  const campaign = search.get("utm_campaign");
  const source = search.get("utm_source");
  const clean: LandingCampaign = {};
  const c = campaign ? sanitizeUtmValue(campaign) : null;
  const s = source ? sanitizeUtmValue(source) : null;
  if (c) clean.campaign = c;
  if (s) clean.source = s;
  if (!clean.campaign && !clean.source) return;
  try {
    window.sessionStorage.setItem(CAMPAIGN_KEY, JSON.stringify(clean));
  } catch {
    // depolama yok: olay kampanyasız gider, akış bozulmaz
  }
}

export function UmamiClient({ scriptUrl, websiteId }: { scriptUrl: string; websiteId: string }) {
  const pathname = usePathname();
  const lastSent = useRef<string | null>(null);

  useEffect(() => {
    const w = umamiWindow();
    w.__arillaUmamiEnabled = true;
    w.__arillaUmamiBeforeSend = (_type, payload) => (w.__arillaUmamiEnabled ? payload : false);
    if (!document.getElementById(SCRIPT_ID)) {
      const script = document.createElement("script");
      script.id = SCRIPT_ID;
      script.defer = true;
      script.src = scriptUrl;
      script.setAttribute("data-website-id", websiteId);
      script.setAttribute("data-auto-track", "false");
      script.setAttribute("data-do-not-track", "true");
      script.setAttribute("data-before-send", "__arillaUmamiBeforeSend");
      document.head.appendChild(script);
    }
    return () => {
      umamiWindow().__arillaUmamiEnabled = false;
    };
  }, [scriptUrl, websiteId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: rota değişimi tetikleyicidir; adres UTM için window.location'dan okunur.
  useEffect(() => {
    const origin = window.location.origin;
    const page = sanitizePage(window.location.href, origin);
    if (page === null) return;
    const location = new URL(page.location);
    rememberLandingCampaign(location.searchParams);
    if (lastSent.current === page.location) return;
    const referrer = lastSent.current ?? sanitizeReferrer(document.referrer, origin);
    lastSent.current = page.location;
    const url = `${location.pathname}${location.search}`;
    whenReady((umami) => {
      umami.track((props) => ({ ...props, url, title: page.title, referrer }));
    });
  }, [pathname]);

  return null;
}

const JOINED_KEY = "arilla.ea-joined";

/**
 * `early_access_joined` (docs/events.md): erken erişim kaydı "az önce katıldı"
 * durumundayken, YALNIZCA analitik rızasıyla (`ConsentGate` içinde) tek olay.
 * Kullanıcı kimliği, e-posta, hesap numarası gönderilmez; olay verisi yalnızca
 * iniş sayfasının güvenli `campaign` / `source` etiketleridir.
 */
export function UmamiEarlyAccessJoined() {
  useEffect(() => {
    const w = umamiWindow();
    let alreadySent = false;
    try {
      alreadySent = window.sessionStorage.getItem(JOINED_KEY) === "1";
    } catch {
      // depolama yok: tekrar bastırma çalışmaz, olay yine tek seferlik render'dır
    }
    if (alreadySent) return;
    // Betiği UmamiClient yükler; etkin bayrağı onun montajıyla gelir.
    w.__arillaUmamiEnabled = w.__arillaUmamiEnabled ?? true;
    whenReady((umami) => {
      umami.track("early_access_joined", readLandingCampaign() as Record<string, string>);
      try {
        window.sessionStorage.setItem(JOINED_KEY, "1");
      } catch {
        // yoksay
      }
    });
  }, []);
  return null;
}
