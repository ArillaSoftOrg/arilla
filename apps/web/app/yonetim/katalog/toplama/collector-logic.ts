import type { ExtractedPage } from "@arilla/core/catalog-collection-extract";

/**
 * Toplayıcı akış mantığı (karar 0115). Ağ, bekleme ve sunucu çağrıları
 * `CollectorEnv` ile dışarıdan verilir; böylece sınırlar (bekleme, bütçe, engelde
 * durma) sahte ortamla birim testlenir.
 *
 * Kurallar: engel görülürse (HTTP 403/429/503, doğrulama sayfası, beklenen
 * yapının yokluğu) koşu DURUR; yeniden deneme ve alternatif yöntem yoktur.
 * Bir sorgunun sonraki sayfası, önceki sayfalarda görülmemiş ürün getirmiyorsa
 * sayfalama çalışıyor sayılmaz ve sorgu orada biter.
 */
export interface CollectedItem {
  externalId: string;
  title: string;
  url: string;
  priceMinor: number;
  currency: "TRY";
  inStock: boolean | null;
  imageUrl: string | null;
  brand: string | null;
}

/** Sunucu yanıtı: alanlar çağrıya göre değişir; kullanım yerinde sınanır. */
// biome-ignore lint/suspicious/noExplicitAny: yanıt şekli işleme göre değişen JSON
export type ApiData = Record<string, any>;

export interface CollectorEnv {
  /** Kaynak sayfasını getirir; yalnızca durum ve metin döner. */
  fetchPage(url: string): Promise<{ status: number; text: string }>;
  extract(html: string): ExtractedPage;
  /** Sunucu API'si (`/api/yonetim/katalog-toplama`). */
  api(body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: ApiData }>;
  sleep(ms: number): Promise<void>;
  now(): Date;
  delayMs: number;
  shouldStop(): boolean;
  log(line: string): void;
  source: string;
}

export interface Checkpoint {
  queries: string[];
  /** Sorgu -> tamamlanan son sayfa. */
  done: Record<string, number>;
  /** Sayfalamanın bittiği (ya da kesildiği) sorgular. */
  finished: Record<string, string>;
}

export interface RunOptions {
  queries: string[];
  maxPages: number;
  resumeRun: {
    id: number;
    requestsMade: number;
    maxRequests: number;
    checkpoint: Record<string, unknown> | null;
  } | null;
}

export type StopReason = "completed" | "paused" | "blocked" | "budget" | "error";

export function searchUrl(query: string, page: number): string {
  const q = encodeURIComponent(query);
  return page <= 1
    ? `https://www.hepsiburada.com/ara?q=${q}`
    : `https://www.hepsiburada.com/ara?q=${q}&sayfa=${page}`;
}

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);

function readCheckpoint(raw: Record<string, unknown> | null, queries: string[]): Checkpoint {
  const cp: Checkpoint = { queries, done: {}, finished: {} };
  if (raw && typeof raw === "object") {
    const done = raw.done as Record<string, unknown> | undefined;
    const finished = raw.finished as Record<string, unknown> | undefined;
    for (const q of queries) {
      if (typeof done?.[q] === "number") cp.done[q] = done[q] as number;
      if (typeof finished?.[q] === "string") cp.finished[q] = finished[q] as string;
    }
  }
  return cp;
}

export async function runCollection(env: CollectorEnv, options: RunOptions): Promise<StopReason> {
  let runId: number;
  let requests: number;
  let maxRequests: number;
  let checkpoint: Checkpoint;

  if (options.resumeRun) {
    runId = options.resumeRun.id;
    requests = options.resumeRun.requestsMade;
    maxRequests = options.resumeRun.maxRequests;
    checkpoint = readCheckpoint(options.resumeRun.checkpoint, options.queries);
    env.log(`Koşu #${runId} sürdürülüyor (${requests}/${maxRequests} istek).`);
  } else {
    const started = await env.api({
      op: "start",
      source: env.source,
      options: { queries: options.queries.length, maxPages: options.maxPages },
    });
    if (!started.ok) {
      env.log(`Koşu başlatılamadı: ${started.data?.error ?? started.status}`);
      return "error";
    }
    runId = started.data.id;
    requests = 0;
    maxRequests = started.data.maxRequests;
    checkpoint = { queries: options.queries, done: {}, finished: {} };
    env.log(`Koşu #${runId} başladı (istek bütçesi ${maxRequests}).`);
  }

  const seen = new Set<string>();
  let reason: StopReason = "completed";

  outer: for (const query of options.queries) {
    if (checkpoint.finished[query]) continue;
    for (let page = (checkpoint.done[query] ?? 0) + 1; page <= options.maxPages; page++) {
      if (env.shouldStop()) {
        reason = "paused";
        break outer;
      }
      if (requests >= maxRequests) {
        reason = "budget";
        break outer;
      }
      if (requests > 0) await env.sleep(env.delayMs);
      requests += 1;
      const fetchedAt = env.now().toISOString();
      let unit: Record<string, unknown>;
      let records: CollectedItem[] = [];
      let blocked = false;
      try {
        const res = await env.fetchPage(searchUrl(query, page));
        if (BLOCK_STATUSES.has(res.status)) {
          blocked = true;
          unit = status(query, page, "blocked", 0, 0, `http_${res.status}`, fetchedAt);
        } else if (res.status !== 200) {
          unit = status(query, page, "failed", 0, 0, `http_${res.status}`, fetchedAt);
          blocked = true; // beklenmeyen durumda da dur: yeniden deneme yok
        } else {
          const parsed = env.extract(res.text);
          if (!parsed.structureFound) {
            blocked = true;
            unit = status(query, page, "blocked", 0, 0, "structure_missing", fetchedAt);
          } else {
            const fresh = parsed.items.filter((i) => !seen.has(i.externalId));
            for (const i of parsed.items) seen.add(i.externalId);
            records = parsed.items.map((i) => ({ ...i }));
            const empty = parsed.items.length === 0;
            unit = status(
              query,
              page,
              empty ? "empty" : "done",
              parsed.items.length,
              fresh.length,
              null,
              fetchedAt,
            );
            if (empty) checkpoint.finished[query] = "empty_page";
            else if (page > 1 && fresh.length === 0) {
              checkpoint.finished[query] = "no_new_items";
            }
          }
        }
      } catch {
        blocked = true;
        unit = status(query, page, "failed", 0, 0, "network_error", fetchedAt);
      }

      const sent = await env.api({
        op: "batch",
        runId,
        requestsMade: requests,
        records: records.map((r) => ({ ...r, foundVia: query, sourceObservedAt: fetchedAt })),
        units: [unit],
        checkpoint: blocked
          ? checkpoint
          : { ...checkpoint, done: { ...checkpoint.done, [query]: page } },
      });
      if (!sent.ok) {
        env.log(`Sunucu reddetti: ${sent.data?.error ?? sent.status}. Koşu duruyor.`);
        return "error";
      }
      if (!blocked) checkpoint.done[query] = page;
      env.log(
        `${query} s.${page}: ${records.length} ürün, sunucuda yeni ${sent.data.inserted}, tekrar ${sent.data.duplicates}, reddedilen ${sent.data.rejected}`,
      );
      if (blocked) {
        env.log(
          `Engel ya da beklenmeyen yanıt (${String(unit.errorCode)}). Koşu durduruldu; yeniden denenmez.`,
        );
        reason = "blocked";
        break outer;
      }
      if (checkpoint.finished[query]) break;
      if (page >= options.maxPages) checkpoint.finished[query] = "page_limit";
    }
  }

  if (reason === "completed" || reason === "budget" || reason === "blocked") {
    const closed = await env.api({
      op: "close",
      runId,
      outcome: reason === "completed" ? "completed" : "aborted",
    });
    if (closed.ok) {
      const c = closed.data;
      env.log(
        `Koşu kapandı: ${c.uniqueRecords} benzersiz ürün, ${c.queries} sorgu, ${c.pagesFetched} sayfa; sayfa tavanında kesilen sorgu ${c.queriesCappedByPageLimit}; sayfalama doğrulanamayan ${c.queriesPaginationUnconfirmed}.`,
      );
    }
  } else {
    env.log("Duraklatıldı; koşu açık, kaldığı yerden sürdürülebilir.");
  }
  return reason;
}

function status(
  query: string,
  page: number,
  st: "done" | "empty" | "failed" | "blocked",
  found: number,
  fresh: number,
  errorCode: string | null,
  fetchedAt: string,
): Record<string, unknown> {
  return { query, page, status: st, itemsFound: found, itemsNew: fresh, errorCode, fetchedAt };
}
