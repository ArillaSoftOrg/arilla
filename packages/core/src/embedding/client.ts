/**
 * Embedding istemcisi — Jina CLIP v2 (barındırılan çok-kipli API).
 *
 * `services/ingest/enrich/client.py`'nin TypeScript yansıması. Aynı sabitler
 * (URL, model adı, boyut) kasıtlı olarak birebir aynı: bir yerel geliştirme
 * ortamında Python `--fake-client` ile ürettiği katalog vektörleri ile bu
 * istemcinin ürettiği sorgu vektörü aynı sahte model uzayına düşmezse görsel
 * arama hiçbir sonuç bulamaz.
 *
 * Sağlayıcı kararı: `docs/decisions/0015-embedding-saglayici.md`. İstemci
 * seçimi `getEmbeddingClient` içinde: anahtar yoksa sessizce sahte istemciye
 * DÜŞÜLMEZ (anlamsız sonuç gerçek sonuç gibi görünürdü); sahte istemci yalnızca
 * `EMBEDDING_FAKE_CLIENT=true` ile ve production dışında açılır — Python
 * tarafındaki açık `--fake-client` bayrağının karşılığı.
 */
import { createHash } from "node:crypto";

const API_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-clip-v2";
const FAKE_MODEL = `${MODEL}-fake`;

/** Şema `vector(768)` taahhüt ediyor. */
export const EMBEDDING_DIMENSIONS = 768;

const MAX_RETRIES = 4;

/**
 * İstek yolunda kullanıcı bekliyor: tek bir deneme bu sürede yanıt vermezse
 * iptal edilir ve (bütçe kaldıysa) yeniden denenir.
 */
const ATTEMPT_TIMEOUT_MS = 15_000;
/**
 * Tüm denemeler ve aradaki beklemeler dahil üst sınır. Bekleme bu sınırı
 * aşacaksa yeniden denenmez, `EmbeddingError` atılır (fail-closed).
 */
const TOTAL_TIMEOUT_MS = 30_000;

export class EmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingError";
  }
}

export interface EmbeddingResult {
  vector: number[];
  modelVersion: string;
  /** `api_usage.units` için; sağlayıcının döndüğü token sayısı. */
  tokens: number;
}

export interface EmbeddingClient {
  embedImage(dataUrl: string): Promise<EmbeddingResult>;
  readonly modelVersion: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Testlerin ağ, saat ve bekleme olmadan zaman aşımı/yeniden deneme yolunu sürebilmesi için. */
export interface JinaClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  attemptTimeoutMs?: number;
  totalTimeoutMs?: number;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** `docs/decisions/0015` ile aynı istisna: istek yolundaki tek model çağrısı. */
export class JinaEmbeddingClient implements EmbeddingClient {
  readonly modelVersion = MODEL;

  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly attemptTimeoutMs: number;
  private readonly totalTimeoutMs: number;

  constructor(
    private readonly apiKey: string,
    options: JinaClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleepImpl = options.sleep ?? sleep;
    this.now = options.now ?? Date.now;
    this.attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
  }

  async embedImage(dataUrl: string): Promise<EmbeddingResult> {
    const body = {
      model: MODEL,
      dimensions: EMBEDDING_DIMENSIONS,
      // Kosinüs mesafesi normalize vektörlerde doğru çalışır; catalog
      // tarafı (services/ingest/enrich/client.py) ile aynı sözleşme.
      normalized: true,
      embedding_type: "float",
      input: [{ image: dataUrl }],
    };

    const payload = await this.postWithRetry(body);
    return this.parse(payload);
  }

  /**
   * Yeniden deneme kuralı değişmedi: 429/5xx yeniden denenir (1 sn, 2 sn, 4 sn
   * bekleme, en fazla 4 deneme), diğer 4xx denenmez, ağ hatası olduğu gibi
   * yükselir. Eklenen: her deneme `ATTEMPT_TIMEOUT_MS` ve kalan toplam
   * bütçeyle sınırlı (gövde okuması dahil); zaman aşımı da yeniden denenir.
   * Bütçe biterse son hata `EmbeddingError` olur, sahte vektöre düşülmez.
   */
  private async postWithRetry(body: unknown): Promise<unknown> {
    const deadline = this.now() + this.totalTimeoutMs;
    let lastFailure = "sağlayıcı yanıt vermedi";
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;

      // Zamanlayıcı fetch'i VE gövde okumasını kapsar; her yolda `finally`'de
      // temizlenir (başarılı denemeden sonra bekleyen zamanlayıcı kalmaz).
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new DOMException("Jina denemesi zaman aşımı", "TimeoutError")),
        Math.min(this.attemptTimeoutMs, remaining),
      );
      try {
        const response = await this.fetchImpl(API_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (response.status < 400) return await response.json();
        if (response.status !== 429 && response.status < 500) {
          const text = await response.text();
          throw new EmbeddingError(`sağlayıcı ${response.status}: ${text.slice(0, 200)}`);
        }
        // Okunmayan gövde bağlantıyı tutmasın; bekleme öncesi bırakılır.
        await response.body?.cancel().catch(() => undefined);
        lastFailure = `sağlayıcı ${response.status} döndü`;
      } catch (error) {
        if (!isAbortError(error)) throw error;
        lastFailure = "sağlayıcı zaman aşımına uğradı";
      } finally {
        clearTimeout(timer);
      }

      if (attempt === MAX_RETRIES - 1) break;
      const backoff = 2 ** attempt * 1000;
      if (this.now() + backoff >= deadline) break;
      await this.sleepImpl(backoff);
    }
    throw new EmbeddingError(
      `${lastFailure}; ${MAX_RETRIES} deneme / ${this.totalTimeoutMs} ms içinde geçmedi`,
    );
  }

  private parse(payload: unknown): EmbeddingResult {
    // Yanıt biçimi OpenAI uyumlu olarak belgeleniyor ama anahtar olmadığı
    // için gerçek bir yanıtla DOĞRULANMADI (services/ingest/enrich/client.py
    // ile aynı durum) - burada açıkça patlaması, sessizce yanlış vektör
    // yazmasından iyidir.
    const rows = (payload as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw new EmbeddingError(
        `yanıt beklenen biçimde değil: 1 girdi gönderildi, ${
          Array.isArray(rows) ? rows.length : "liste değil"
        } sonuç geldi`,
      );
    }
    const vector = (rows[0] as { embedding?: unknown }).embedding;
    if (!Array.isArray(vector) || vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        `vektör boyutu ${EMBEDDING_DIMENSIONS} bekleniyordu, ${
          Array.isArray(vector) ? vector.length : "yok"
        } geldi`,
      );
    }
    const usage = (payload as { usage?: { total_tokens?: number } }).usage;
    return {
      vector: vector.map((value) => Number(value)),
      modelVersion: MODEL,
      tokens: usage?.total_tokens ?? 0,
    };
  }
}

/**
 * Deterministik sahte istemci — testler ve gerçek anahtar gelmeden önceki
 * geliştirme için. Aynı girdi her zaman aynı vektörü verir, farklı girdiler
 * farklı. Gerçek anlamsal yakınlık TAŞIMAZ.
 */
export class FakeEmbeddingClient implements EmbeddingClient {
  readonly modelVersion = FAKE_MODEL;

  async embedImage(dataUrl: string): Promise<EmbeddingResult> {
    return {
      vector: this.vectorFor(dataUrl),
      modelVersion: FAKE_MODEL,
      tokens: Math.max(1, Math.floor(dataUrl.length / 4)),
    };
  }

  private vectorFor(input: string): number[] {
    const seed = createHash("sha256").update(input, "utf8").digest();
    const raw = Array.from(
      { length: EMBEDDING_DIMENSIONS },
      (_, index) => (seed[index % seed.length] ?? 0) / 255 - 0.5,
    );
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0)) || 1;
    return raw.map((value) => value / norm);
  }
}

export type EmbeddingUnavailableReason = "missing_api_key" | "fake_client_in_production";

/**
 * Sağlayıcı yapılandırılmamış: görsel arama bu ortamda çalışamaz. Sahte
 * sonuç üretmek yerine atılır; çağıran taraf kullanıcıya dürüst bir
 * "şu an kullanılamıyor" durumu gösterir. Mesaj gizli değer içermez.
 */
export class EmbeddingUnavailableError extends EmbeddingError {
  constructor(readonly reason: EmbeddingUnavailableReason) {
    super(
      reason === "missing_api_key"
        ? "JINA_API_KEY tanımlı değil; görsel embedding sağlayıcısı kullanılamıyor"
        : "EMBEDDING_FAKE_CLIENT=true production ortamında kullanılamaz",
    );
    this.name = "EmbeddingUnavailableError";
  }
}

type EmbeddingEnv = Readonly<Record<string, string | undefined>>;

function fakeClientRequested(env: EmbeddingEnv): boolean {
  return env.EMBEDDING_FAKE_CLIENT?.trim().toLowerCase() === "true";
}

/**
 * - `JINA_API_KEY` dolu → gerçek Jina istemcisi.
 * - `EMBEDDING_FAKE_CLIENT=true` ve `NODE_ENV` production değil → sahte istemci
 *   (yalnızca yerel geliştirme ve testler; anahtar varsa anahtar kazanır).
 * - `EMBEDDING_FAKE_CLIENT=true` production'da → `EmbeddingUnavailableError`
 *   (yapılandırma hatası; anahtar olsa bile, bayrağın kendisi yanlış).
 * - Anahtar yok, bayrak yok → `EmbeddingUnavailableError`. Sessiz düşüş yok.
 */
export function getEmbeddingClient(env: EmbeddingEnv = process.env): EmbeddingClient {
  const fakeRequested = fakeClientRequested(env);
  if (fakeRequested && env.NODE_ENV === "production") {
    throw new EmbeddingUnavailableError("fake_client_in_production");
  }
  const apiKey = env.JINA_API_KEY?.trim();
  if (apiKey) return new JinaEmbeddingClient(apiKey);
  if (fakeRequested) return new FakeEmbeddingClient();
  throw new EmbeddingUnavailableError("missing_api_key");
}
