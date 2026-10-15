"use client";

import {
  networkLooksMetered,
  type RunnerEnv,
  runDiscovery,
} from "@arilla/core/catalog-discovery-client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

const API = "/api/yonetim/katalog-kesif";
const FETCH_TIMEOUT_MS = 180_000;
/** Sunucunun istedigi bekleme bundan uzunsa (gunluk tavan) oturum durur; sekme bos beklemez. */
const MAX_WAIT_MS = 5 * 60_000;

interface ActiveOperation {
  id: number;
  kind: "initial_import" | "weekly_refresh";
  status: string;
  clientActive: boolean;
  leaseClient: string | null;
}

/** Sekme kimligi: sekme yenilense de ayni kira korunur. Depolama yoksa yeni kimlik (akis bozulmaz). */
function tabClientId(): string {
  const fresh = `tab-${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
  try {
    const existing = sessionStorage.getItem("katalog-kesif-istemci");
    if (existing && /^[A-Za-z0-9_-]{8,64}$/.test(existing)) return existing;
    sessionStorage.setItem("katalog-kesif-istemci", fresh);
  } catch {
    /* depolama kapali: oturum kimligi bellekte kalir */
  }
  return fresh;
}

function connectionInfo(): { type?: string; saveData?: boolean; effectiveType?: string } | null {
  const nav = navigator as Navigator & {
    connection?: { type?: string; saveData?: boolean; effectiveType?: string };
  };
  return nav.connection ?? null;
}

/**
 * Sitemap keşfi istemcisi (karar 0120). Kaynak dosyaları BU tarayıcıdan, çerezsiz istenir;
 * yöneticinin internet bağlantısı kullanılır. Sunucu her istekten önce hak verir (aralık,
 * günlük tavan, bütçe); akış kuralları `@arilla/core/catalog-discovery-client` içindedir.
 * Büyük aktarım varsayılan KAPALIDIR: ağ beyanı ve onay kutusu olmadan başlamaz.
 */
export function DiscoveryClient({
  source,
  rules,
  active,
  canStartInitial,
  canStartRefresh,
}: {
  source: string;
  rules: { urlHost: string; imageHost: string };
  active: ActiveOperation | null;
  canStartInitial: boolean;
  canStartRefresh: boolean;
}) {
  const router = useRouter();
  const [network, setNetwork] = useState<"" | "wifi" | "wired">("");
  const [largeTransfer, setLargeTransfer] = useState(false);
  const [filesPerSession, setFilesPerSession] = useState(20);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  // Sekme kimligi yalnizca tarayicida uretilir (sunucu cizimi sirasinda depolama/crypto yok).
  const [myId, setMyId] = useState<string | null>(null);
  useEffect(() => setMyId(tabClientId()), []);

  const append = (line: string) => setLog((prev) => [...prev.slice(-299), line]);
  const id = () => myId ?? tabClientId();

  async function api(body: Record<string, unknown>) {
    const res = await fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
  }

  function preflight(): boolean {
    if (!largeTransfer) {
      append("Büyük aktarım kapalı. Başlatmak için onay kutusunu işaretle.");
      return false;
    }
    if (network !== "wifi" && network !== "wired") {
      append("Bağlantı türünü (Wi-Fi ya da kablolu) seç. Mobil veriyle büyük aktarım başlatılmaz.");
      return false;
    }
    if (networkLooksMetered(connectionInfo())) {
      append(
        "Tarayıcı mobil veri ya da veri tasarrufu bildiriyor. Aktarım başlatılmadı; Wi-Fi ya da kablolu bağlantıya geç.",
      );
      return false;
    }
    return true;
  }

  async function run(operationId: number) {
    stop.current = false;
    setRunning(true);
    const env: RunnerEnv = {
      operationId,
      clientId: id(),
      rules,
      batchSize: 1000,
      maxFilesThisSession: Math.min(Math.max(filesPerSession, 1), 500),
      maxWaitMs: MAX_WAIT_MS,
      log: append,
      shouldStop: () => stop.current,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      api,
      async fetchSource(url) {
        const res = await fetch(url, {
          mode: "cors",
          credentials: "omit",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        const length = Number(res.headers.get("content-length"));
        return {
          status: res.status,
          contentType: res.headers.get("content-type"),
          contentLength: Number.isFinite(length) && length > 0 ? length : null,
          body: res.body,
        };
      },
    };
    try {
      const reason = await runDiscovery(env);
      append(`Oturum bitti: ${reason}.`);
    } catch (error) {
      append(`Durdu: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  async function start(kind: "initial_import" | "weekly_refresh") {
    if (!preflight()) return;
    const res = await api({ op: "start", source, kind, network, clientId: id() });
    if (!res.ok) {
      append(
        `Başlatılamadı: ${res.data?.error ?? res.status}${res.data?.detail ? ` (${res.data.detail})` : ""}`,
      );
      return;
    }
    append(
      `Operasyon #${res.data.id} başladı (${kind === "initial_import" ? "ilk aktarım" : "haftalık yenileme"}).`,
    );
    await run(res.data.id);
  }

  async function resume() {
    if (!active || !preflight()) return;
    const res = await api({ op: "resume", operationId: active.id, clientId: id() });
    if (!res.ok) {
      append(
        `Sürdürülemedi: ${res.data?.error ?? res.status}${res.data?.detail ? ` (${res.data.detail})` : ""}`,
      );
      return;
    }
    await run(active.id);
  }

  async function pause() {
    if (running) {
      stop.current = true;
      append("Durdurma istendi; işlenen dosya bitince duraklatılacak.");
      return;
    }
    if (!active) return;
    const res = await api({ op: "pause", operationId: active.id });
    append(res.ok ? "Duraklatıldı." : `Duraklatılamadı: ${res.data?.error ?? res.status}`);
    router.refresh();
  }

  async function cancel() {
    if (!active || running) return;
    const res = await api({ op: "cancel", operationId: active.id });
    append(
      res.ok ? "Operasyon iptal edildi." : `İptal edilemedi: ${res.data?.error ?? res.status}`,
    );
    router.refresh();
  }

  const otherClient =
    active?.clientActive === true && active.leaseClient !== null && active.leaseClient !== myId;

  return (
    <div>
      <fieldset disabled={running} style={{ border: 0, padding: 0 }}>
        <p>
          <label>
            <input
              type="checkbox"
              checked={largeTransfer}
              onChange={(e) => setLargeTransfer(e.target.checked)}
            />{" "}
            Büyük aktarımı etkinleştir (bu bağlantıdan sitemap dosyaları indirilecek)
          </label>
        </p>
        <p>
          Bağlantı türü:{" "}
          <label>
            <input
              type="radio"
              name="ag"
              checked={network === "wifi"}
              onChange={() => setNetwork("wifi")}
            />{" "}
            Wi-Fi
          </label>{" "}
          <label>
            <input
              type="radio"
              name="ag"
              checked={network === "wired"}
              onChange={() => setNetwork("wired")}
            />{" "}
            Kablolu
          </label>
        </p>
        <p>
          <label>
            Bu oturumda en fazla dosya{" "}
            <input
              type="number"
              min={1}
              max={500}
              value={filesPerSession}
              onChange={(e) => setFilesPerSession(Number(e.target.value))}
            />
          </label>
        </p>
      </fieldset>
      <p>
        {active ? (
          <>
            <button type="button" disabled={running} onClick={resume}>
              {otherClient
                ? `Başka bir sekmede çalışıyor (#${active.id})`
                : `Bu tarayıcıda sürdür (#${active.id}, ${active.status})`}
            </button>{" "}
            <button type="button" disabled={!running && active.status !== "open"} onClick={pause}>
              Duraklat
            </button>{" "}
            <button type="button" disabled={running} onClick={cancel}>
              İptal et
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              disabled={running || !canStartInitial}
              onClick={() => start("initial_import")}
            >
              İlk aktarımı başlat (haftalık hakkı harcamaz)
            </button>{" "}
            <button
              type="button"
              disabled={running || !canStartRefresh}
              onClick={() => start("weekly_refresh")}
            >
              Haftalık yenilemeyi başlat (bu ayın 1 hakkını harcar)
            </button>
          </>
        )}
      </p>
      <p>
        Sekmeyi açık ve görünür tut. Sekme kapanırsa ilerleme kaybolmaz: işlenen her dosya sunucuda
        kayıtlıdır ve “sürdür” ile kalan dosyadan devam edilir. İşlem kendiliğinden başka bir
        tarayıcıda devam etmez.
      </p>
      <pre aria-live="polite" style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
