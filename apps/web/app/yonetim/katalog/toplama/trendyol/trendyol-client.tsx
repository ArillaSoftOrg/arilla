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
 * istek atmaz. Otomatik gezinme yoktur: "Siradakini ac" yalnizca yoneticinin tikladigi adresi
 * acar. Butce ve tekillik sunucuda yeniden sinanir.
 */
export function TrendyolRelayClient({
  canStart,
  openRun,
}: {
  canStart: boolean;
  openRun: OpenRun | null;
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

  const append = (line: string) => setLog((prev) => [...prev.slice(-199), line]);

  async function flush() {
    if (busy.current || !state.current || stopped) return;
    busy.current = true;
    try {
      while (queue.current.length > 0 && state.current) {
        const pages = queue.current.splice(0, queue.current.length);
        const plan = planRelayBatch(state.current, pages);
        if (plan.batch) {
          const res = await api(plan.batch as unknown as Record<string, unknown>);
          if (!res.ok) {
            setStopped(String(res.data?.error ?? res.status));
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
        setExtension(msg.version);
        if (state.current && !stopped)
          send({ channel: RELAY_CHANNEL, type: "arm", runId: state.current.runId });
        return;
      }
      if (!state.current || stopped) return;
      queue.current.push(...msg.pages);
      void flush();
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [run, stopped]);

  async function start() {
    const res = await api({ op: "start", source: "trendyol" });
    if (!res.ok) {
      append(`Başlatılamadı: ${res.data?.error ?? res.status} ${res.data?.detail ?? ""}`);
      return;
    }
    const r = res.data as OpenRun;
    state.current = {
      runId: r.id,
      requestsMade: r.requestsMade,
      maxRequests: r.maxRequests,
      processedCaptures: new Set(),
      sentProducts: new Set(),
    };
    setRun(r);
    setStopped(null);
    send({ channel: RELAY_CHANNEL, type: "arm", runId: r.id });
    append(`Koşu #${r.id} açıldı (kotadan 1 hak). Trendyol sayfalarını aç; eklenti okur.`);
  }

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
