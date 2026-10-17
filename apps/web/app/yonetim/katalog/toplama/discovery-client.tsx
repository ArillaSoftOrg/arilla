"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { type DiscoveryEnv, runDiscovery } from "./discovery-logic.ts";
import { collectionPageLoadedAsDocument, RELOAD_REQUIRED_TEXT } from "./document-load.ts";

interface OpenDiscoveryRun {
  id: number;
  requestsMade: number;
  requestsReserved: number;
  maxRequests: number;
  maxBytes: number;
  bytesDownloaded: number;
  approvedBytes: number;
}

const API = "/api/yonetim/katalog-toplama";
const FETCH_TIMEOUT_MS = 120_000;
const MIB = 1024 * 1024;

const ORIGINS = [
  ["admin_wifi", "Yönetici Wi-Fi"],
  ["admin_wired", "Yönetici kablolu bağlantı"],
  ["admin_mobile", "Yönetici mobil veri (kotalı olabilir)"],
] as const;

/**
 * Sitemap keşfi toplayıcısı (karar 0120). Yöneticinin tarayıcısında çalışır; dosyalar tek
 * tek, bekleyerek ve akışla okunur. İndirme için bayt onayı zorunludur ve sunucu onaysız
 * baytı reddeder. Akış kuralları `discovery-logic.ts`'te.
 */
export function DiscoveryClient({
  source,
  canStart,
  openRun,
}: {
  source: string;
  canStart: boolean;
  openRun: OpenDiscoveryRun | null;
}) {
  const [approveMiB, setApproveMiB] = useState(
    openRun ? Math.max(Math.ceil(openRun.approvedBytes / MIB), 1) : 100,
  );
  const [origin, setOrigin] = useState<(typeof ORIGINS)[number][0]>("admin_wifi");
  const [delaySeconds, setDelaySeconds] = useState(3);
  const [maxFiles, setMaxFiles] = useState(3);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const router = useRouter();

  const append = (line: string) => setLog((prev) => [...prev.slice(-199), line]);

  async function run(resume: boolean) {
    // CSP izni yalniz belge bu yolda yuklendiyse gecerli; degilse istek ATILMAZ (butce harcanmaz).
    if (!collectionPageLoadedAsDocument()) {
      append(RELOAD_REQUIRED_TEXT);
      window.location.reload();
      return;
    }
    stop.current = false;
    setRunning(true);
    const env: DiscoveryEnv = {
      source,
      delayMs: Math.min(Math.max(delaySeconds, 2), 120) * 1000,
      maxDecodedBytesPerFile: 256 * MIB,
      shouldStop: () => stop.current,
      log: append,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      async fetchSource(url) {
        const res = await fetch(url, {
          mode: "cors",
          credentials: "omit",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        return { status: res.status, body: res.status === 200 ? res.body : null };
      },
      async api(body) {
        const res = await fetch(API, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { ok: res.ok, status: res.status, data: await res.json().catch(() => ({})) };
      },
    };
    try {
      await runDiscovery(env, {
        approveBytes: Math.max(Math.trunc(approveMiB), 1) * MIB,
        transferOrigin: origin,
        maxFilesThisSession: Math.min(Math.max(Math.trunc(maxFiles), 1), 50),
        resumeRun: resume && openRun ? { ...openRun } : null,
      });
    } catch (error) {
      append(`Durdu: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
    } finally {
      setRunning(false);
      router.refresh();
    }
  }

  return (
    <div>
      <p>
        <label>
          İndirme onayı (MiB){" "}
          <input
            type="number"
            min={1}
            value={approveMiB}
            onChange={(e) => setApproveMiB(Number(e.target.value))}
            disabled={running}
          />
        </label>{" "}
        <label>
          Ağ kaynağı (beyan){" "}
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value as (typeof ORIGINS)[number][0])}
            disabled={running}
          >
            {ORIGINS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      </p>
      <p>
        <label>
          Dosyalar arası bekleme (sn){" "}
          <input
            type="number"
            min={2}
            max={120}
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(Number(e.target.value))}
            disabled={running}
          />
        </label>{" "}
        <label>
          Bu oturumda en fazla dosya{" "}
          <input
            type="number"
            min={1}
            max={50}
            value={maxFiles}
            onChange={(e) => setMaxFiles(Number(e.target.value))}
            disabled={running}
          />
        </label>
      </p>
      <p>
        {openRun ? (
          <button type="button" disabled={running} onClick={() => run(true)}>
            Açık keşif koşusunu sürdür (#{openRun.id}, {openRun.requestsMade}/{openRun.maxRequests}{" "}
            istek)
          </button>
        ) : (
          <button type="button" disabled={running || !canStart} onClick={() => run(false)}>
            Yeni keşif koşusu başlat (kotadan 1 hak harcar)
          </button>
        )}{" "}
        <button type="button" disabled={!running} onClick={() => (stop.current = true)}>
          Duraklat
        </button>
      </p>
      <p>
        İndirme tavanı politikada koşu başına belirlidir; onay bu tavanı aşamaz. İlk aktarımın
        gerçek trafiği ölçülmediği için küçük bir onayla (örn. 100 MiB) ve az dosyayla başla;
        sayaçlar yukarıdaki koşu özetinde görünür.
      </p>
      <pre aria-live="polite" style={{ maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
