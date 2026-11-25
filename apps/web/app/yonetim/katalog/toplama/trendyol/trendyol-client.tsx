"use client";

import {
  outcomeForStop,
  paceDelayMs,
  RECHECK_MS,
  type ScheduleOutcome,
} from "@arilla/core/catalog-collection-schedule-logic";
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
const SCHEDULE_API = "/api/yonetim/katalog-toplama/zamanlama";
/** Son sayfanin yakalanip aktarilmasi icin bekleme (otomatik koşu sonu). */
const SETTLE_MS = 20_000;
const HELLO_WAIT_MS = 15_000;

async function post(url: string, body: Record<string, unknown>) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
}

const api = (body: Record<string, unknown>) => post(API, body);

function send(message: ToExtensionMessage) {
  // Yalniz ayni pencere ve kendi kokenimiz; eklentinin icerik betigi bu pencerede dinler.
  window.postMessage(message, window.location.origin);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Decision =
  | { action: "start" }
  | { action: "interrupted"; runId: number }
  | { action: "wait"; reason: string; nextCheckAt: string };

/**
 * Eklentinin yakaladigi Trendyol sayfalarini kosuya aktarir (karar 0118). Bu sayfa Trendyol'a
 * istek atmaz. Elle kullanımda "Siradakini ac" yalnizca yoneticinin tikladigi adresi acar.
 *
 * Otomatik kip (karar 0221, `?otomatik=1`; eklentinin zamanlayicisi acar): sunucuya "koşu
 * baslatilabilir mi" diye sorar (kota sunucuda), izin varsa kayitli hedefleri eklentiye birer
 * birer, en az `paceSeconds` arayla actirir; sonunda koşuyu kapatir ve sonucu kaydeder.
 */
export function TrendyolRelayClient({
  canStart,
  openRun,
  autoMode,
}: {
  canStart: boolean;
  openRun: OpenRun | null;
  autoMode: boolean;
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
  /** Durma nedeni (otomatik dongu de okur). */
  const stopRef = useRef<string | null>(null);
  const relayStop = useRef<"budget" | "blocked" | null>(null);
  const autoStarted = useRef(false);

  const append = (line: string) => setLog((prev) => [...prev.slice(-199), line]);

  function halt(code: string) {
    stopRef.current = code;
    setStopped(code);
  }

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
            halt(String(res.data?.error ?? res.status));
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
          relayStop.current = plan.stop;
          halt(plan.stop);
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
    relayStop.current = null;
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

  async function closeRun(runId: number, outcome: "completed" | "aborted"): Promise<boolean> {
    send({ channel: RELAY_CHANNEL, type: "disarm" });
    const res = await api({ op: "close", runId, outcome });
    append(
      res.ok
        ? `Koşu kapandı: ${res.data.uniqueRecords} benzersiz ürün, ${res.data.productPages} ürün + ${res.data.listingPages} liste sayfası.`
        : `Kapatılamadı: ${res.data?.error ?? res.status}`,
    );
    if (res.ok) {
      setRun(null);
      state.current = null;
    }
    return res.ok;
  }

  async function close(outcome: "completed" | "aborted") {
    if (!run) return;
    await flush();
    if (outcome === "completed" && !(await sendPending(true))) return;
    await closeRun(run.id, outcome);
  }

  // ---------------------------------------------------------------- otomatik kip (karar 0221)

  async function scheduleStatus(): Promise<Decision | null> {
    const res = await post(SCHEDULE_API, { op: "status", source: "trendyol" });
    if (!res.ok) {
      append(`Zamanlama durumu okunamadı: ${res.data?.error ?? res.status}`);
      return null;
    }
    return res.data.schedule.decision as Decision;
  }

  function hint(at: Date) {
    send({ channel: RELAY_CHANNEL, type: "schedule_hint", nextCheckAt: at.toISOString() });
  }

  async function report(runId: number, outcome: ScheduleOutcome, errorCode: string | null) {
    await post(SCHEDULE_API, { op: "outcome", source: "trendyol", runId, outcome, errorCode });
    append(`Zamanlanmış koşu #${runId} sonucu: ${outcome}${errorCode ? ` (${errorCode})` : ""}.`);
  }

  async function runSchedule() {
    let decision = await scheduleStatus();
    if (!decision) return hint(new Date(Date.now() + RECHECK_MS));
    if (decision.action === "interrupted") {
      // Onceki zamanlanmis koşu yarida kaldi (tarayici/sayfa kapandi): kapat ve bildir.
      append(`Yarım kalan zamanlanmış koşu #${decision.runId} kapatılıyor.`);
      await closeRun(decision.runId, "aborted");
      await report(decision.runId, "interrupted", "page_closed");
      decision = await scheduleStatus();
      if (!decision) return hint(new Date(Date.now() + RECHECK_MS));
    }
    if (decision.action === "wait") {
      append(`Zamanlanmış koşu yok: ${decision.reason}. Sonraki yoklama ${decision.nextCheckAt}.`);
      return hint(new Date(decision.nextCheckAt));
    }
    if (decision.action !== "start") return hint(new Date(Date.now() + RECHECK_MS));
    // Koşu surerken eklenti bu sayfayi yeniden acmasin.
    hint(new Date(Date.now() + 2 * RECHECK_MS));
    const res = await post(SCHEDULE_API, { op: "start", source: "trendyol" });
    if (!res.ok) {
      append(`Zamanlanmış koşu açılamadı: ${res.data?.error ?? res.status}`);
      return hint(new Date(Date.now() + RECHECK_MS));
    }
    const {
      run: opened,
      targetUrls,
      paceSeconds,
    } = res.data as {
      run: OpenRun;
      targetUrls: string[];
      paceSeconds: number;
    };
    adopt(opened);
    append(
      `Zamanlanmış koşu #${opened.id}: ${targetUrls.length} adres, en az ${paceSeconds} sn ara.`,
    );
    for (const [i, url] of targetUrls.entries()) {
      if (stopRef.current) break;
      send({ channel: RELAY_CHANNEL, type: "navigate", runId: opened.id, url });
      setCursor(i + 1);
      await sleep(paceDelayMs(paceSeconds, Math.random()));
    }
    await sleep(stopRef.current ? 0 : SETTLE_MS);
    await flush();
    const serverError = stopRef.current && !relayStop.current ? stopRef.current : null;
    const outcome: ScheduleOutcome = serverError ? "error" : outcomeForStop(relayStop.current);
    // Yarim tarama tam kapsam sayilmaz (karar 0140): yalniz eksiksiz koşu "completed" kapanir.
    const pendingOk = await sendPending(true);
    await closeRun(opened.id, outcome === "completed" && pendingOk ? "completed" : "aborted");
    await report(
      opened.id,
      pendingOk ? outcome : "error",
      serverError ?? (relayStop.current === "blocked" ? "structure_missing" : null),
    );
    send({ channel: RELAY_CHANNEL, type: "finish" });
    const next = await scheduleStatus();
    hint(next?.action === "wait" ? new Date(next.nextCheckAt) : new Date(Date.now() + RECHECK_MS));
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: otomatik kip sayfa basina bir kez calisir
  useEffect(() => {
    if (!autoMode || autoStarted.current) return;
    if (!extension) {
      const t = setTimeout(() => {
        if (!autoStarted.current) append("Otomatik kip: eklenti bulunamadı; koşu açılmadı.");
      }, HELLO_WAIT_MS);
      return () => clearTimeout(t);
    }
    autoStarted.current = true;
    void runSchedule().catch(() => append("Otomatik kip beklenmeyen hatayla durdu."));
  }, [autoMode, extension]);

  const list = urls
    .split("\n")
    .map((u) => u.trim())
    .filter((u) => /^https:\/\/www\.trendyol\.com\//.test(u));

  function openNext() {
    const next = list[cursor];
    if (!next) return;
    // Yalniz yoneticinin tiklamasiyla tek sayfa acilir.
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
        {autoMode ? " · Otomatik kip (zamanlayıcı açtı)" : null}
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
          <button type="button" disabled={!canStart || !extension || autoMode} onClick={start}>
            Yeni koşu başlat (kotadan 1 hak harcar)
          </button>
        )}
      </p>
      {stopped ? <p role="alert">Koşu durduruldu: {stopped}</p> : null}
      {autoMode ? null : (
        <>
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
        </>
      )}
      <pre aria-live="polite" style={{ maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
