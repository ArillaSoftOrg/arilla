"use client";

import {
  type CapturedPage,
  flushPendingListings,
  MAX_RECORDS_PER_BATCH,
  parseToPageMessage,
  planRelayBatch,
  RELAY_CHANNEL,
  type RelayState,
  type ToExtensionMessage,
} from "@arilla/core/catalog-collection-trendyol-relay";
import { useEffect, useRef, useState } from "react";

interface OpenRun {
  id: number;
  requestsMade: number;
  maxRequests: number;
  expiresAt: string;
}

const API = "/api/yonetim/katalog-toplama";
/** Zamanlayici yoklamasi (Hepsiburada toplayicisiyla ayni, karar 0220/0221). */
const SCHEDULE_POLL_MS = 10 * 60_000;
const SCHEDULE_FIRST_POLL_MS = 60_000;
/** Iki sayfa acilisi arasi en az bekleme; ustune %0-50 rastgele (nazik hiz). */
const PACE_MS = 30_000;
/** Son sayfanin yakalanip aktarilmasi icin bekleme (zamanlanmis kosu sonu). */
const SETTLE_MS = 20_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function api(body: Record<string, unknown>) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

function send(message: ToExtensionMessage) {
  // Yalniz ayni pencere ve kendi kokenimiz; eklentinin icerik betigi bu pencerede dinler.
  window.postMessage(message, window.location.origin);
}

/**
 * Eklentinin yakaladigi Trendyol sayfalarini kosuya aktarir (karar 0118). Bu sayfa Trendyol'a
 * istek atmaz. Elle kullanımda "Siradakini ac" yalnizca yoneticinin tikladigi adresi acar.
 *
 * Zamanlanmis toplama (karar 0221; `CATALOG_AUTO_COLLECT_ENABLED`, Hepsiburada ile ortak
 * zamanlayici): bu sekme acik ve gorunurken sunucuya sorar; kota KAYNAK POLITIKASINDAN sunucuda
 * uygulanir. Izin varsa son kosunun okunan adreslerini eklentiye birer birer, en az 30 sn +
 * rastgele arayla actirir; sonunda koşuyu kapatir. Engelde durur, yeniden denemez.
 */
export function TrendyolRelayClient({
  canStart,
  openRun,
  autoEnabled = false,
}: {
  canStart: boolean;
  openRun: OpenRun | null;
  autoEnabled?: boolean;
}) {
  const [run, setRun] = useState<OpenRun | null>(openRun);
  const [extension, setExtension] = useState<string | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [urls, setUrls] = useState("");
  const [cursor, setCursor] = useState(0);
  const [stopped, setStopped] = useState<string | null>(null);
  const state = useRef<RelayState | null>(
    openRun
      ? {
          runId: openRun.id,
          requestsMade: openRun.requestsMade,
          maxRequests: openRun.maxRequests,
          processedCaptures: new Set(),
          sentProducts: new Set(),
        }
      : null,
  );
  const busy = useRef(false);
  const queue = useRef<CapturedPage[]>([]);
  /** Durma nedeni (zamanlanmis dongu de okur). */
  const stopRef = useRef<string | null>(null);
  const autoBusy = useRef(false);
  const extensionRef = useRef<string | null>(null);

  const append = (line: string) => setLog((prev) => [...prev.slice(-199), line]);

  async function flush() {
    if (busy.current || !state.current || stopRef.current) return;
    busy.current = true;
    try {
      while (queue.current.length > 0 && state.current) {
        const pages = queue.current.splice(0, queue.current.length);
        const plan = planRelayBatch(state.current, pages);
        if (plan.batch) {
          const res = await api(plan.batch as unknown as Record<string, unknown>);
          if (!res.ok) {
            stopRef.current = String(res.data?.error ?? res.status);
            setStopped(stopRef.current);
            append(`Durdu: sunucu ${res.status} ${res.data?.error ?? ""}`);
            send({ channel: RELAY_CHANNEL, type: "disarm" });
            return;
          }
          append(
            `Parti: ${plan.batch.units.length} sayfa, ${res.data.inserted} yeni, ${res.data.duplicates} tekrar, ${res.data.rejected} red; istek ${res.data.requestsMade}/${state.current.maxRequests}`,
          );
        }
        if (plan.captureIds.length > 0) {
          send({ channel: RELAY_CHANNEL, type: "ack", captureIds: plan.captureIds });
        }
        await sendPending(false);
        if (plan.stop) {
          stopRef.current = plan.stop;
          setStopped(plan.stop);
          append(
            plan.stop === "budget"
              ? "Durdu: koşu istek bütçesi doldu."
              : "Durdu: beklenen sayfa yapısı yok (engel ya da değişiklik). Yeniden deneme yok.",
          );
          send({ channel: RELAY_CHANNEL, type: "disarm" });
          return;
        }
      }
    } finally {
      busy.current = false;
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: dinleyici kosu degisince yeniden kurulur
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const msg = parseToPageMessage(event.data);
      if (!msg) return;
      if (msg.type === "hello") {
        extensionRef.current = msg.version;
        setExtension(msg.version);
        if (state.current && !stopRef.current)
          send({ channel: RELAY_CHANNEL, type: "arm", runId: state.current.runId });
        return;
      }
      if (!state.current || stopRef.current) return;
      queue.current.push(...msg.pages);
      void flush();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [run, stopped]);

  function adopt(r: OpenRun) {
    state.current = {
      runId: r.id,
      requestsMade: r.requestsMade,
      maxRequests: r.maxRequests,
      processedCaptures: new Set(),
      sentProducts: new Set(),
    };
    stopRef.current = null;
    setRun(r);
    setStopped(null);
    send({ channel: RELAY_CHANNEL, type: "arm", runId: r.id });
  }

  async function start() {
    const res = await api({ op: "start", source: "trendyol" });
    if (!res.ok) {
      append(`Başlatılamadı: ${res.data?.error ?? res.status} ${res.data?.detail ?? ""}`);
      return;
    }
    const r = res.data as OpenRun;
    adopt(r);
    append(`Koşu #${r.id} açıldı (kotadan 1 hak). Trendyol sayfalarını aç; eklenti okur.`);
  }

  /** Zamanlanmis kosu: sunucunun verdigi adresleri eklentiye birer birer actirir. */
  async function runScheduled(r: OpenRun, urls: string[]) {
    adopt(r);
    append(`Zamanlanmış koşu #${r.id}: ${urls.length} adres, en az 30 sn arayla.`);
    for (const [i, url] of urls.entries()) {
      if (stopRef.current) break;
      send({ channel: RELAY_CHANNEL, type: "navigate", runId: r.id, url });
      setCursor(i + 1);
      await sleep(PACE_MS * (1 + Math.random() * 0.5));
    }
    if (!stopRef.current) await sleep(SETTLE_MS);
    await flush();
    const complete = !stopRef.current && (await sendPending(true));
    // Yarim tarama tam kapsam sayilmaz (karar 0140): yalniz eksiksiz koşu "completed" kapanir.
    send({ channel: RELAY_CHANNEL, type: "disarm" });
    const res = await api({
      op: "close",
      runId: r.id,
      outcome: complete ? "completed" : "aborted",
    });
    append(
      res.ok
        ? `Zamanlanmış koşu kapandı (${complete ? "tamamlandı" : "yarıda kaldı"}): ${res.data.uniqueRecords} benzersiz ürün.`
        : `Kapatılamadı: ${res.data?.error ?? res.status}`,
    );
    if (res.ok) {
      setRun(null);
      state.current = null;
    }
    send({ channel: RELAY_CHANNEL, type: "finish" });
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: zamanlayici yalniz bayrakla kurulur
  useEffect(() => {
    if (!autoEnabled) return;
    let cancelled = false;
    async function tick() {
      if (cancelled || autoBusy.current || state.current) return;
      if (document.visibilityState !== "visible" || !extensionRef.current) return;
      const status = await api({ op: "schedule_status", source: "trendyol" }).catch(() => null);
      if (cancelled || !status?.ok || !status.data?.due || state.current) return;
      autoBusy.current = true;
      try {
        append("Zamanlanmış toplama zamanı geldi; koşu açılıyor.");
        const started = await api({ op: "schedule_start", source: "trendyol" }).catch(() => null);
        if (!started?.ok) {
          append(`Zamanlanmış koşu açılamadı: ${started?.data?.error ?? "bağlantı hatası"}`);
          return;
        }
        const { run: r, urls } = started.data as { run: OpenRun; urls: string[] };
        await runScheduled(
          {
            id: r.id,
            requestsMade: 0,
            maxRequests: r.maxRequests,
            expiresAt: String(r.expiresAt),
          },
          urls,
        );
      } catch {
        append("Zamanlanmış koşu beklenmeyen hatayla durdu.");
      } finally {
        autoBusy.current = false;
      }
    }
    const first = setTimeout(tick, SCHEDULE_FIRST_POLL_MS);
    const every = setInterval(tick, SCHEDULE_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(every);
    };
  }, [autoEnabled]);

  /** Bekleyen liste kayitlarini gonderir; hata olursa false. */
  async function sendPending(all: boolean): Promise<boolean> {
    while (state.current) {
      const size = state.current.pendingListings?.size ?? 0;
      if (size === 0 || (!all && size < MAX_RECORDS_PER_BATCH)) return true;
      const body = flushPendingListings(state.current);
      if (!body) return true;
      const res = await api(body as unknown as Record<string, unknown>);
      if (!res.ok) {
        append(`Liste kayıtları gönderilemedi: ${res.data?.error ?? res.status}`);
        return false;
      }
      append(`Liste kayıtları: ${res.data.inserted} yeni, ${res.data.duplicates} tekrar.`);
    }
    return true;
  }

  async function close(outcome: "completed" | "aborted") {
    if (!run) return;
    await flush();
    if (outcome === "completed" && !(await sendPending(true))) return;
    send({ channel: RELAY_CHANNEL, type: "disarm" });
    const res = await api({ op: "close", runId: run.id, outcome });
    append(
      res.ok
        ? `Koşu kapandı: ${res.data.uniqueRecords} benzersiz ürün, ${res.data.productPages} ürün + ${res.data.listingPages} liste sayfası.`
        : `Kapatılamadı: ${res.data?.error ?? res.status}`,
    );
    if (res.ok) {
      setRun(null);
      state.current = null;
    }
  }

  const list = urls
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => /^https:\/\/www\.trendyol\.com\//.test(u));

  function openNext() {
    const next = list[cursor];
    if (!next) return;
    // Yalniz yoneticinin tiklamasiyla tek sayfa acilir; otomatik gezinme yok.
    window.open(next, "trendyol-toplama", "noopener");
    setCursor((c) => c + 1);
  }

  return (
    <div>
      {autoEnabled ? (
        <p>
          Zamanlanmış toplama açık: bu sekme açık ve görünürken, kaynak politikasının izin verdiği
          zaman geldiğinde son koşunun adresleri eklentiyle tek sekmede, arayla açılır.
        </p>
      ) : null}
      <p>
        Eklenti:{" "}
        <strong>
          {extension ? `bağlı (${extension})` : "bulunamadı (yüklü ve bu sayfaya izinli mi?)"}
        </strong>
      </p>
      <p>
        {run ? (
          <>
            Koşu #{run.id} açık, son geçerlilik {new Date(run.expiresAt).toLocaleString("tr-TR")}.{" "}
            <button type="button" onClick={() => close("completed")}>
              Koşuyu tamamla
            </button>{" "}
            <button type="button" onClick={() => close("aborted")}>
              İptal et
            </button>
          </>
        ) : (
          <button type="button" disabled={!canStart || !extension} onClick={start}>
            Yeni koşu başlat (kotadan 1 hak harcar)
          </button>
        )}
      </p>
      {stopped ? <p role="alert">Koşu durduruldu: {stopped}</p> : null}
      <label>
        İsteğe bağlı adres listesi (satır başına bir Trendyol ürün ya da liste adresi)
        <textarea
          rows={5}
          value={urls}
          onChange={(e) => {
            setUrls(e.target.value);
            setCursor(0);
          }}
          style={{ width: "100%", fontFamily: "inherit" }}
        />
      </label>
      <p>
        <button type="button" disabled={!run || cursor >= list.length} onClick={openNext}>
          Sıradakini aç ({cursor}/{list.length})
        </button>
      </p>
      <pre aria-live="polite" style={{ maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
