import {
  bodyToTextStream,
  looksLikeHtml,
  recordFromSitemapEntry,
  type SitemapDiscoveryRecord,
  SitemapIndexParser,
  SitemapParseError,
  SitemapUrlsetParser,
} from "@arilla/core/catalog-discovery-extract";
import type { ApiData } from "./collector-logic.ts";

/**
 * Sitemap kesfi akis mantigi (karar 0120). Ag, bekleme ve sunucu cagrilari
 * `DiscoveryEnv` ile disaridan verilir; sinirlar sahte ortamla birim testlenir.
 *
 * Kurallar: dosyalar TEK TEK ve istekler arasinda beklenerek indirilir; govde belleğe
 * toptan alinmaz (akisli ayristirma); engel (HTTP 401/403/429/503, HTML sayfasi) ya da
 * hata goruldugunde kosu DURUR, yeniden deneme ve alternatif yontem yoktur. Onayli bayt
 * tavani indirme sirasinda da uygulanir. Fiyat okunmaz: sitemap'te yoktur.
 */
export const SITEMAP_ORIGIN = "https://www.hepsiburada.com";
export const SITEMAP_INDEX_KEY = "sitemaps/product/sitemap.xml";
const PRODUCT_SITEMAP_PATH = /^\/sitemaps\/product\/[A-Za-z0-9_./-]{1,150}\.xml(?:\.gz)?$/;
const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

export interface DiscoveryEnv {
  /** Kaynak dosyasini ister; govde akis olarak doner (toptan okunmaz). */
  fetchSource(url: string): Promise<{ status: number; body: ReadableStream<Uint8Array> | null }>;
  api(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: ApiData }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  delayMs: number;
  shouldStop(): boolean;
  log(line: string): void;
  source: string;
  /** Tek dosya icin acilmis bayt ust siniri (sikistirma bombasi korumasi). */
  maxDecodedBytesPerFile: number;
}

export interface DiscoveryRunOptions {
  approveBytes: number;
  transferOrigin: "vps" | "admin_wifi" | "admin_wired" | "admin_mobile";
  /** Bu oturumda en fazla kac dosya indirilir (kosu sonraki oturumda surer). */
  maxFilesThisSession: number;
  resumeRun: {
    id: number;
    requestsMade: number;
    /** Sunucuda rezerve edilmis toplam (>= requestsMade); yoksa requestsMade. */
    requestsReserved?: number;
    maxRequests: number;
    bytesDownloaded: number;
    approvedBytes: number;
  } | null;
}

export type DiscoveryStopReason =
  | "completed"
  | "paused"
  | "blocked"
  | "budget"
  | "bytes"
  | "daily_quota"
  | "monthly_quota"
  | "session_limit"
  | "error";

type FileOutcome =
  | { kind: "ok"; items: SitemapDiscoveryRecord[]; skipped: number; bytes: number }
  | { kind: "index"; keys: string[]; bytes: number }
  | {
      kind: "stop";
      status: "blocked" | "failed";
      errorCode: string;
      reason: DiscoveryStopReason;
      bytes: number;
    };

async function readUnit(
  env: DiscoveryEnv,
  key: string,
  remainingBytes: number,
): Promise<FileOutcome> {
  let res: Awaited<ReturnType<DiscoveryEnv["fetchSource"]>>;
  try {
    res = await env.fetchSource(`${SITEMAP_ORIGIN}/${key}`);
  } catch {
    return {
      kind: "stop",
      status: "failed",
      errorCode: "network_error",
      reason: "error",
      bytes: 0,
    };
  }
  if (BLOCK_STATUSES.has(res.status)) {
    await res.body?.cancel().catch(() => {});
    return {
      kind: "stop",
      status: "blocked",
      errorCode: `http_${res.status}`,
      reason: "blocked",
      bytes: 0,
    };
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => {});
    return {
      kind: "stop",
      status: "failed",
      errorCode: `http_${res.status}`,
      reason: "error",
      bytes: 0,
    };
  }
  const isIndex = key === SITEMAP_INDEX_KEY;
  const maxDecodedBytes = Math.max(1, Math.min(env.maxDecodedBytesPerFile, remainingBytes));
  let decoded = () => 0;
  try {
    const text = await bodyToTextStream(res.body, `${SITEMAP_ORIGIN}/${key}`, { maxDecodedBytes });
    decoded = text.decodedBytes;
    const reader = text.stream.getReader();
    const indexParser = isIndex ? new SitemapIndexParser() : null;
    const urlParser = isIndex ? null : new SitemapUrlsetParser();
    const items: SitemapDiscoveryRecord[] = [];
    const keys: string[] = [];
    let skipped = 0;
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        if (looksLikeHtml(value)) {
          await reader.cancel().catch(() => {});
          return {
            kind: "stop",
            status: "blocked",
            errorCode: "structure_missing",
            reason: "blocked",
            bytes: decoded(),
          };
        }
      }
      if (indexParser) {
        for (const e of indexParser.push(value)) {
          try {
            const u = new URL(e.loc);
            if (u.hostname.endsWith("hepsiburada.com") && PRODUCT_SITEMAP_PATH.test(u.pathname)) {
              keys.push(u.pathname.slice(1));
            }
          } catch {
            /* gecersiz adres: atla */
          }
        }
      } else if (urlParser) {
        for (const e of urlParser.push(value)) {
          const r = recordFromSitemapEntry(e, key);
          if (r) items.push(r);
          else skipped += 1;
        }
      }
    }
    const end = (indexParser ?? urlParser)?.end();
    if (!end?.rootSeen) {
      return {
        kind: "stop",
        status: "blocked",
        errorCode: "structure_missing",
        reason: "blocked",
        bytes: decoded(),
      };
    }
    if (end.truncated) {
      return {
        kind: "stop",
        status: "failed",
        errorCode: "truncated",
        reason: "error",
        bytes: decoded(),
      };
    }
    return isIndex
      ? { kind: "index", keys: [...new Set(keys)], bytes: decoded() }
      : { kind: "ok", items, skipped, bytes: decoded() };
  } catch (error) {
    if (error instanceof SitemapParseError) {
      const bytes = Math.min(decoded(), remainingBytes);
      return error.code === "decoded_limit"
        ? { kind: "stop", status: "failed", errorCode: "decoded_limit", reason: "bytes", bytes }
        : { kind: "stop", status: "failed", errorCode: error.code, reason: "error", bytes };
    }
    return {
      kind: "stop",
      status: "failed",
      errorCode: "network_error",
      reason: "error",
      bytes: Math.min(decoded(), remainingBytes),
    };
  }
}

export async function runDiscovery(
  env: DiscoveryEnv,
  options: DiscoveryRunOptions,
): Promise<DiscoveryStopReason> {
  let runId: number;
  let requests: number;
  let reserved: number;
  let maxRequests: number;
  let bytes: number;
  let approved: number;

  if (options.resumeRun) {
    ({
      id: runId,
      requestsMade: requests,
      maxRequests,
      bytesDownloaded: bytes,
    } = options.resumeRun);
    approved = options.resumeRun.approvedBytes;
    reserved = Math.max(options.resumeRun.requestsReserved ?? 0, requests);
    env.log(`Koşu #${runId} sürdürülüyor (${requests}/${maxRequests} istek, ${bytes} bayt).`);
  } else {
    const started = await env.api({ op: "start", source: env.source, options: {} });
    if (!started.ok) {
      env.log(`Koşu başlatılamadı: ${started.data?.error ?? started.status}`);
      return "error";
    }
    runId = started.data.id;
    requests = 0;
    reserved = 0;
    bytes = 0;
    approved = 0;
    maxRequests = started.data.maxRequests;
    env.log(`Koşu #${runId} başladı (istek bütçesi ${maxRequests}).`);
  }

  if (approved < options.approveBytes) {
    const ok = await env.api({
      op: "discovery_approve",
      runId,
      bytes: options.approveBytes,
      transferOrigin: options.transferOrigin,
    });
    if (!ok.ok) {
      env.log(
        `İndirme onayı reddedildi: ${ok.data?.error ?? ok.status}. Hiçbir dosya indirilmedi.`,
      );
      return "error";
    }
    approved = ok.data.approvedBytes;
  }

  const planned = await env.api({
    op: "discovery_plan",
    runId,
    kind: "sitemap_file",
    keys: [SITEMAP_INDEX_KEY],
  });
  if (!planned.ok) {
    env.log(`Plan yazılamadı: ${planned.data?.error ?? planned.status}`);
    return "error";
  }

  let reason: DiscoveryStopReason = "completed";
  let files = 0;
  const base = { mode: "discovery", indexKey: SITEMAP_INDEX_KEY };

  for (;;) {
    if (env.shouldStop()) {
      reason = "paused";
      break;
    }
    const next = await env.api({ op: "discovery_next", runId, limit: 1 });
    if (!next.ok) {
      env.log(`Sıradaki birim alınamadı: ${next.data?.error ?? next.status}`);
      return "error";
    }
    const unit = (next.data.units as { unitKey: string }[])[0];
    if (!unit) break;
    if (files >= options.maxFilesThisSession) {
      reason = "session_limit";
      break;
    }
    if (reserved >= maxRequests) {
      reason = "budget";
      break;
    }
    if (bytes >= approved) {
      reason = "bytes";
      break;
    }
    if (requests > 0) await env.sleep(env.delayMs);
    // Kaynaga istek atmadan ONCE atomik rezervasyon (karar 0124). Reddedilirse istek ATILMAZ.
    const hold = await env.api({ op: "discovery_reserve", runId, count: 1 });
    if (!hold.ok) {
      const code = String(hold.data?.error ?? hold.status);
      if (code === "collection_quota_daily_requests") {
        env.log("Bugünkü HTTP isteği hakkı doldu; UTC gün dönümünden sonra sürdürülebilir.");
        reason = "daily_quota";
      } else if (code === "collection_quota_monthly_requests") {
        env.log("Bu ayın HTTP isteği hakkı doldu; UTC ay başından sonra sürdürülebilir.");
        reason = "monthly_quota";
      } else {
        env.log(`İstek rezervasyonu reddedildi: ${code}. İstek atılmadı.`);
        return "error";
      }
      break;
    }
    reserved = Number(hold.data.requestsReserved);
    requests += 1;
    files += 1;
    const fetchedAt = env.now().toISOString();
    const out = await readUnit(env, unit.unitKey, approved - bytes);

    if (out.kind === "index") {
      if (out.keys.length === 0) {
        env.log("İndeks ürün sitemap dosyası içermiyor; durdu.");
        reason = "blocked";
      } else {
        for (let i = 0; i < out.keys.length; i += 5000) {
          const p = await env.api({
            op: "discovery_plan",
            runId,
            kind: "sitemap_file",
            keys: out.keys.slice(i, i + 5000),
          });
          if (!p.ok) {
            env.log(`Plan yazılamadı: ${p.data?.error ?? p.status}`);
            return "error";
          }
        }
        env.log(`İndeks okundu: ${out.keys.length} ürün sitemap dosyası planlandı.`);
      }
    }

    const stop = out.kind === "stop" || (out.kind === "index" && out.keys.length === 0);
    const sent = await env.api({
      op: "discovery_batch",
      runId,
      kind: "sitemap_file",
      unitKey: unit.unitKey,
      status:
        out.kind === "stop"
          ? out.status
          : stop
            ? "failed"
            : out.kind === "ok" && out.items.length === 0
              ? "empty"
              : "done",
      bytesReceived: out.bytes,
      requestsMade: requests,
      fetchedAt,
      items: out.kind === "ok" ? out.items : [],
      errorCode: out.kind === "stop" ? out.errorCode : stop ? "index_empty" : null,
      checkpoint: { ...base, lastUnit: unit.unitKey },
    });
    if (!sent.ok) {
      env.log(`Sunucu reddetti: ${sent.data?.error ?? sent.status}. Koşu duruyor.`);
      return "error";
    }
    bytes = sent.data.bytesDownloaded;
    if (out.kind === "ok") {
      env.log(
        `${unit.unitKey}: ${out.items.length} kimlik (yeni ${sent.data.inserted}, tekrar ${sent.data.seenAgain}, reddedilen ${sent.data.rejected}, ürün olmayan ${out.skipped}).`,
      );
    }
    if (out.kind === "stop") {
      env.log(`${unit.unitKey}: ${out.errorCode}. Koşu durduruldu; yeniden denenmez.`);
      reason = out.reason;
      break;
    }
    if (stop) break;
  }

  if (reason === "completed") {
    const prog = await env.api({ op: "discovery_progress", source: env.source, runId });
    const u = (prog.data?.unitsByStatus ?? {}) as Record<string, number>;
    const open = (u.pending ?? 0) + (u.failed ?? 0) + (u.blocked ?? 0);
    const closed = await env.api({
      op: "close",
      runId,
      outcome: open === 0 ? "completed" : "aborted",
    });
    env.log(
      `Koşu kapandı (${closed.ok ? "tamam" : "kapatılamadı"}): ${prog.data?.uniqueProducts ?? "?"} benzersiz kimlik; tamamlanmamış birim ${open}. Bu sayı katalogun tamamı olarak sunulmaz.`,
    );
  } else if (reason === "blocked") {
    await env.api({ op: "close", runId, outcome: "aborted" });
  } else {
    env.log("Durdu; koşu açık, kaldığı birimden sürdürülebilir.");
  }
  return reason;
}
