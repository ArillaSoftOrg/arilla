"use client";

import { extractHepsiburadaPage } from "@arilla/core/catalog-collection-extract";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { type CollectorEnv, runCollection } from "./collector-logic.ts";
import { collectionPageLoadedAsDocument, RELOAD_REQUIRED_TEXT } from "./document-load.ts";

interface OpenRun {
  id: number;
  requestsMade: number;
  maxRequests: number;
  expiresAt: string;
  checkpoint: Record<string, unknown> | null;
}

const API = "/api/yonetim/katalog-toplama";
const FETCH_TIMEOUT_MS = 25_000;

/**
 * Yöneticinin tarayıcısında çalışan toplayıcı (karar 0117, sözlü izin
 * kapsamında; yazılı lisans değildir). Kaynak sayfası çerezsiz ve yalnızca bu
 * tarayıcının kendi kimliğiyle istenir; akış kuralları `collector-logic.ts`'te:
 * istekler arası bekleme, sunucu tarafı istek bütçesi, engelde durma.
 */
export function CollectorClient({
  source,
  canStart,
  openRun,
}: {
  source: string;
  canStart: boolean;
  openRun: OpenRun | null;
}) {
  const [queries, setQueries] = useState(
    Array.isArray(openRun?.checkpoint?.queries)
      ? (openRun.checkpoint.queries as string[]).join("\n")
      : "",
  );
  const [maxPages, setMaxPages] = useState(3);
  const [delaySeconds, setDelaySeconds] = useState(4);
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const stop = useRef(false);
  const router = useRouter();

  const append = (line: string) => setLog((prev) => [...prev.slice(-199), line]);

  async function run(resume: boolean) {
    const list = [
      ...new Set(
        queries
          .split("\n")
          .map((q) => q.trim())
          .filter(Boolean),
      ),
    ];
    if (list.length === 0) {
      append("Sorgu listesi boş.");
      return;
    }
    // CSP izni yalniz belge bu yolda yuklendiyse gecerli; degilse istek ATILMAZ (butce harcanmaz).
    if (!collectionPageLoadedAsDocument()) {
      append(RELOAD_REQUIRED_TEXT);
      window.location.reload();
      return;
    }
    stop.current = false;
    setRunning(true);
    const env: CollectorEnv = {
      source,
      extract: extractHepsiburadaPage,
      delayMs: Math.min(Math.max(delaySeconds, 2), 60) * 1000,
      shouldStop: () => stop.current,
      log: append,
      now: () => new Date(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      async fetchPage(url) {
        const res = await fetch(url, {
          mode: "cors",
          credentials: "omit",
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        return { status: res.status, text: res.status === 200 ? await res.text() : "" };
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
      await runCollection(env, {
        queries: list,
        maxPages,
        resumeRun: resume ? openRun : null,
      });
    } catch (error) {
      append(`Durdu: ${error instanceof Error ? error.message : "bilinmeyen hata"}`);
    } finally {
      setRunning(false);
      // Kota ve acik kosu durumu sunucudan yeniden okunur (acik kalan kosu "surdur" ile devam eder).
      router.refresh();
    }
  }

  return (
    <div>
      <label>
        Sorgular (satır başına bir terim)
        <textarea
          rows={8}
          value={queries}
          onChange={(e) => setQueries(e.target.value)}
          disabled={running}
          style={{ width: "100%", fontFamily: "inherit" }}
        />
      </label>
      <p>
        <label>
          Sorgu başına en fazla sayfa{" "}
          <input
            type="number"
            min={1}
            max={50}
            value={maxPages}
            onChange={(e) => setMaxPages(Number(e.target.value))}
            disabled={running}
          />
        </label>{" "}
        <label>
          İstekler arası bekleme (sn){" "}
          <input
            type="number"
            min={2}
            max={60}
            value={delaySeconds}
            onChange={(e) => setDelaySeconds(Number(e.target.value))}
            disabled={running}
          />
        </label>
      </p>
      <p>
        {openRun ? (
          <button type="button" disabled={running} onClick={() => run(true)}>
            Açık koşuyu sürdür (#{openRun.id}, {openRun.requestsMade}/{openRun.maxRequests} istek)
          </button>
        ) : (
          <button type="button" disabled={running || !canStart} onClick={() => run(false)}>
            Yeni koşu başlat (kotadan 1 hak harcar)
          </button>
        )}{" "}
        <button type="button" disabled={!running} onClick={() => (stop.current = true)}>
          Duraklat
        </button>
      </p>
      <p>Bu sekmeyi açık ve görünür tut: arka plandaki sekmelerde zamanlayıcılar yavaşlar.</p>
      <pre aria-live="polite" style={{ maxHeight: 280, overflow: "auto", whiteSpace: "pre-wrap" }}>
        {log.join("\n")}
      </pre>
    </div>
  );
}
