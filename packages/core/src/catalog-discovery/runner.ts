/**
 * Yonetici tarayicisinda calisan sitemap kesif dongusu (karar 0120). Ag, bekleme ve sunucu
 * cagrilari `RunnerEnv` ile disaridan verilir; sinirlar sahte ortamla birim testlenir.
 * Veritabani bagimliligi YOKTUR (istemci paketine girer).
 *
 * Kurallar:
 *  - Her kaynak isteginden once sunucudan hak alinir; sunucu "bekle" derse beklenir.
 *  - 401/403/429/503, HTML/dogrulama sayfasi ya da beklenen sitemap yapisinin yoklugu ENGEL
 *    sayilir: bildirilir ve dongu durur. Yeniden deneme, alternatif yol, kimlik degistirme yok.
 *  - Ag hatasi (yanit hic yok) engel kaniti degildir: dosya 'failed' bildirilir ve dongu durur;
 *    operasyon acik kalir, yonetici surdurebilir (otomatik yeniden deneme yok).
 *  - Diger HTTP hatalari dosyayi 'failed' yapar ve bir sonraki dosyaya gecilir; ardisik
 *    hatalar `maxConsecutiveFailures`e ulasinca dongu durur.
 *  - Dosya bellege toptan alinmaz: govde akisla acilir ve ayristirilir, kayitlar partiler
 *    halinde gonderilir.
 */
import { type DiscoveryItem, type DiscoveryRules, itemFromSitemapEntry } from "./items.ts";
import {
  bodyToTextStream,
  type DecompressorFactory,
  looksLikeHtml,
  SitemapIndexParser,
  SitemapParseError,
  SitemapUrlsetParser,
} from "./sitemap-stream.ts";

/** Sunucu yaniti: alanlar islemlere gore degisir; kullanim yerinde sinanir. */
// biome-ignore lint/suspicious/noExplicitAny: yanit sekli isleme gore degisen JSON
export type DiscoveryApiData = Record<string, any>;

export interface SourceResponse {
  status: number;
  contentType: string | null;
  /** `Content-Length` (aktarilan bayt; sikistirilmis olabilir). Bilinmiyorsa null. */
  contentLength: number | null;
  body: ReadableStream<Uint8Array> | null;
}

export interface RunnerEnv {
  operationId: number;
  clientId: string;
  rules: DiscoveryRules;
  /** Kaynak dosyasini getirir (cerezsiz, bu tarayicinin kendi kimligiyle). */
  fetchSource(url: string): Promise<SourceResponse>;
  /** Sunucu API'si (`/api/yonetim/katalog-kesif`). */
  api(
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; status: number; data: DiscoveryApiData }>;
  sleep(ms: number): Promise<void>;
  shouldStop(): boolean;
  log(line: string): void;
  decompressor?: DecompressorFactory;
  /** Parti basina kayit (sunucu en fazla 2000 kabul eder). */
  batchSize: number;
  /** Bu oturumda islenecek en fazla dosya; dolunca operasyon duraklatilir. */
  maxFilesThisSession: number;
  /** Sunucunun istedigi bekleme bundan uzunsa (gunluk tavan) oturum durur. */
  maxWaitMs: number;
  maxConsecutiveFailures?: number;
}

export type RunnerStop =
  | "completed"
  | "paused"
  | "session_limit"
  | "daily_limit"
  | "blocked"
  | "network"
  | "error";

type UnitOutcome = "done" | "failed" | "blocked" | "network" | "fatal";

const BLOCK_STATUSES = new Set([401, 403, 429, 503]);
const PLAN_CHUNK = 2000;

/** Tarayici `fetch` hatasinin adi ve mesaji (gizli bilgi icermez; yoneticiye gosterilir). */
export function describeSourceError(error: unknown): { code: string; detail: string } {
  const name = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const code = name === "TimeoutError" || name === "AbortError" ? "timeout" : "network_error";
  return { code, detail: `${name}: ${message}`.slice(0, 200) };
}

/** `navigator.connection` benzeri nesne: mobil/veri tasarrufu belirtisi varsa buyuk aktarim yapilmaz. */
export function networkLooksMetered(
  connection: { type?: string; saveData?: boolean; effectiveType?: string } | null | undefined,
): boolean {
  if (!connection) return false;
  return (
    connection.type === "cellular" ||
    connection.saveData === true ||
    connection.effectiveType === "slow-2g" ||
    connection.effectiveType === "2g"
  );
}

async function report(
  env: RunnerEnv,
  seq: number,
  outcome: "failed" | "blocked",
  errorCode: string,
  errorDetail: string | null,
  bytes: { decoded: number; transferred: number },
): Promise<void> {
  const res = await env.api({
    op: "fail",
    operationId: env.operationId,
    clientId: env.clientId,
    seq,
    outcome,
    errorCode,
    errorDetail,
    bytesDecoded: bytes.decoded,
    bytesTransferred: bytes.transferred,
  });
  if (!res.ok) env.log(`Hata kaydı sunucuya yazılamadı: ${res.data?.error ?? res.status}`);
}

interface Claim {
  seq: number;
  unitKind: "index" | "file";
  url: string;
  attempt: number;
  maxDecodedBytes: number;
}

async function processUnit(env: RunnerEnv, claim: Claim): Promise<UnitOutcome> {
  const label = claim.unitKind === "index" ? "İndeks" : `Dosya #${claim.seq}`;
  let res: SourceResponse;
  try {
    res = await env.fetchSource(claim.url);
  } catch (error) {
    const f = describeSourceError(error);
    await report(env, claim.seq, "failed", f.code, f.detail, { decoded: 0, transferred: 0 });
    env.log(
      `${label}: kaynaktan yanıt alınamadı (${f.code}: ${f.detail}). Bu bir engel kanıtı değildir; ayrıntı tarayıcı konsolundadır. Operasyon açık kaldı; otomatik yeniden deneme yok.`,
    );
    return "network";
  }
  const transferred = res.contentLength ?? 0;
  if (BLOCK_STATUSES.has(res.status)) {
    await res.body?.cancel().catch(() => {});
    await report(env, claim.seq, "blocked", `http_${res.status}`, null, {
      decoded: 0,
      transferred: 0,
    });
    env.log(`${label}: HTTP ${res.status}. Erişim engeli olarak kaydedildi; operasyon durdu.`);
    return "blocked";
  }
  if (res.status !== 200 || !res.body) {
    await res.body?.cancel().catch(() => {});
    await report(
      env,
      claim.seq,
      "failed",
      res.status !== 200 ? `http_${res.status}` : "empty_body",
      null,
      {
        decoded: 0,
        transferred,
      },
    );
    env.log(`${label}: HTTP ${res.status}; dosya hatalı olarak işaretlendi.`);
    return "failed";
  }
  if (res.contentType && /text\/html/i.test(res.contentType)) {
    await res.body.cancel().catch(() => {});
    await report(env, claim.seq, "blocked", "html_response", null, { decoded: 0, transferred });
    env.log(
      `${label}: sitemap yerine HTML sayfası geldi; engel olarak kaydedildi, operasyon durdu.`,
    );
    return "blocked";
  }

  let decoded = () => 0;
  try {
    const text = await bodyToTextStream(res.body, claim.url, {
      maxDecodedBytes: claim.maxDecodedBytes,
      decompressor: env.decompressor,
    });
    decoded = text.decodedBytes;
    return claim.unitKind === "index"
      ? await consumeIndex(env, claim, text.stream, decoded, transferred, label)
      : await consumeFile(env, claim, text.stream, decoded, transferred, label);
  } catch (error) {
    if (error instanceof ApiRejected) {
      env.log(`Sunucu reddetti: ${error.message}. Oturum duruyor.`);
      return "fatal";
    }
    const code =
      error instanceof SitemapParseError
        ? error.code
        : error instanceof Error && error.name === "TypeError"
          ? "stream_error"
          : "parse_error";
    const detail = error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 200) : null;
    await report(env, claim.seq, "failed", code, detail, { decoded: decoded(), transferred });
    env.log(`${label}: okunamadı (${code}); dosya hatalı olarak işaretlendi.`);
    // Acma bicimi desteklenmiyorsa diger dosyalar da acilamaz: oturum durur.
    return code === "decode_unsupported" ? "fatal" : "failed";
  }
}

class ApiRejected extends Error {}

async function call(env: RunnerEnv, body: Record<string, unknown>): Promise<DiscoveryApiData> {
  const res = await env.api(body);
  if (!res.ok) throw new ApiRejected(String(res.data?.error ?? res.status));
  return res.data;
}

async function* chunks(stream: ReadableStream<string>): AsyncGenerator<string> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

async function consumeIndex(
  env: RunnerEnv,
  claim: Claim,
  stream: ReadableStream<string>,
  decoded: () => number,
  transferred: number,
  label: string,
): Promise<UnitOutcome> {
  const parser = new SitemapIndexParser();
  const files: { url: string; lastmod: string | null }[] = [];
  let first = true;
  for await (const chunk of chunks(stream)) {
    if (first && looksLikeHtml(chunk)) {
      await report(env, claim.seq, "blocked", "challenge_page", null, {
        decoded: decoded(),
        transferred,
      });
      env.log(`${label}: doğrulama/engel sayfası geldi; operasyon durdu.`);
      return "blocked";
    }
    first = false;
    for (const e of parser.push(chunk)) files.push({ url: e.loc, lastmod: e.lastmod });
  }
  const end = parser.end();
  if (!end.rootSeen) {
    await report(env, claim.seq, "blocked", "structure_missing", null, {
      decoded: decoded(),
      transferred,
    });
    env.log(`${label}: sitemap indeks yapısı bulunamadı; engel/yapı değişikliği olarak durdu.`);
    return "blocked";
  }
  if (end.truncated) {
    await report(env, claim.seq, "failed", "truncated", null, { decoded: decoded(), transferred });
    return "failed";
  }
  let planned = 0;
  let rejected = 0;
  for (let i = 0; i < files.length || i === 0; i += PLAN_CHUNK) {
    const part = files.slice(i, i + PLAN_CHUNK);
    const final = i + PLAN_CHUNK >= files.length;
    const data = await call(env, {
      op: "plan",
      operationId: env.operationId,
      clientId: env.clientId,
      files: part,
      final,
      ...(final ? { bytesDecoded: decoded(), bytesTransferred: transferred } : {}),
    });
    planned = Number(data.filesPlanned ?? planned);
    rejected += Number(data.rejected ?? 0);
  }
  env.log(`İndeks: ${files.length} dosya bulundu, ${planned} planlandı, ${rejected} reddedildi.`);
  return "done";
}

async function consumeFile(
  env: RunnerEnv,
  claim: Claim,
  stream: ReadableStream<string>,
  decoded: () => number,
  transferred: number,
  label: string,
): Promise<UnitOutcome> {
  const parser = new SitemapUrlsetParser();
  let batch: DiscoveryItem[] = [];
  let batchIndex = 0;
  let found = 0;
  let valid = 0;
  let inserted = 0;
  let rejected = 0;
  let first = true;
  const send = async (final: boolean) => {
    const data = await call(env, {
      op: "items",
      operationId: env.operationId,
      clientId: env.clientId,
      seq: claim.seq,
      batchIndex,
      items: batch,
      final,
      ...(final
        ? { stats: { itemsFound: found, bytesDecoded: decoded(), bytesTransferred: transferred } }
        : {}),
    });
    inserted += Number(data.inserted ?? 0);
    rejected += Number(data.rejected ?? 0);
    batchIndex += 1;
    batch = [];
  };
  for await (const chunk of chunks(stream)) {
    if (first && looksLikeHtml(chunk)) {
      await report(env, claim.seq, "blocked", "challenge_page", null, {
        decoded: decoded(),
        transferred,
      });
      env.log(`${label}: doğrulama/engel sayfası geldi; operasyon durdu.`);
      return "blocked";
    }
    first = false;
    for (const entry of parser.push(chunk)) {
      found += 1;
      const item = itemFromSitemapEntry(entry, env.rules);
      if (!item) continue;
      valid += 1;
      batch.push(item);
      if (batch.length >= env.batchSize) await send(false);
    }
  }
  const end = parser.end();
  if (!end.rootSeen) {
    await report(env, claim.seq, "blocked", "structure_missing", null, {
      decoded: decoded(),
      transferred,
    });
    env.log(`${label}: sitemap yapısı bulunamadı; engel/yapı değişikliği olarak durdu.`);
    return "blocked";
  }
  if (end.truncated) {
    // Gonderilen partiler idempotenttir; dosya yeniden denendiginde tekrar kayit olusmaz.
    await report(env, claim.seq, "failed", "truncated", null, { decoded: decoded(), transferred });
    env.log(`${label}: dosya yarım geldi; hatalı olarak işaretlendi.`);
    return "failed";
  }
  await send(true);
  env.log(
    `${label}: ${found} adres, ${valid} ürün, yeni ${inserted}, reddedilen ${rejected}, ${(decoded() / 1_048_576).toFixed(1)} MB.`,
  );
  return "done";
}

/** Operasyonu bu tarayicida, oturum sinirlarina kadar ilerletir. */
export async function runDiscovery(env: RunnerEnv): Promise<RunnerStop> {
  const maxFailures = env.maxConsecutiveFailures ?? 3;
  let files = 0;
  let consecutiveFailures = 0;
  const pause = async (why: string) => {
    const res = await env.api({ op: "pause", operationId: env.operationId });
    env.log(res.ok ? `${why} Operasyon duraklatıldı; kaldığı yerden sürdürülebilir.` : why);
  };
  for (;;) {
    if (env.shouldStop()) {
      await pause("Durdurma istendi.");
      return "paused";
    }
    if (files >= env.maxFilesThisSession) {
      await pause(`Bu oturumun dosya sınırına (${env.maxFilesThisSession}) ulaşıldı.`);
      return "session_limit";
    }
    const res = await env.api({
      op: "claim",
      operationId: env.operationId,
      clientId: env.clientId,
    });
    if (!res.ok) {
      env.log(
        `Hak alınamadı: ${res.data?.error ?? res.status}${res.data?.detail ? ` (${res.data.detail})` : ""}.`,
      );
      return "error";
    }
    const claim = res.data;
    if (claim.kind === "done") {
      env.log(`Operasyon tamamlandı (${claim.status}).`);
      return "completed";
    }
    if (claim.kind === "wait") {
      const waitMs = Number(claim.waitMs) || 1000;
      if (waitMs > env.maxWaitMs) {
        env.log(
          claim.reason === "daily_limit"
            ? `Günlük istek tavanı doldu; yaklaşık ${Math.ceil(waitMs / 60_000)} dakika sonra sürdürülebilir.`
            : `Sunucu ${Math.ceil(waitMs / 1000)} sn bekleme istedi; oturum durdu.`,
        );
        return "daily_limit";
      }
      await env.sleep(waitMs);
      continue;
    }
    const outcome = await processUnit(env, claim as Claim);
    if (outcome === "blocked") return "blocked";
    if (outcome === "network") return "network";
    if (outcome === "fatal") return "error";
    if (claim.unitKind === "file") files += 1;
    if (outcome === "failed") {
      consecutiveFailures += 1;
      if (consecutiveFailures >= maxFailures) {
        env.log(`Art arda ${consecutiveFailures} dosya hatası; oturum durdu (operasyon açık).`);
        return "error";
      }
    } else {
      consecutiveFailures = 0;
    }
  }
}
