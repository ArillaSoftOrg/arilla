/**
 * Embedding istemcisi — Jina CLIP v2 (barındırılan çok-kipli API).
 *
 * `services/ingest/enrich/client.py`'nin TypeScript yansıması. Aynı sabitler
 * (URL, model adı, boyut) kasıtlı olarak birebir aynı: bir yerel geliştirme
 * ortamında Python `--fake-client` ile ürettiği katalog vektörleri ile bu
 * istemcinin ürettiği sorgu vektörü aynı sahte model uzayına düşmezse görsel
 * arama hiçbir sonuç bulamaz.
 *
 * Sağlayıcı kararı: `docs/decisions/0015-embedding-saglayici.md`. Gerçek API
 * yolu yazılı ama `JINA_API_KEY` boşken hiç çağrılmaz — B3'teki emsalin
 * aynısı.
 */
import { createHash } from "node:crypto";

const API_URL = "https://api.jina.ai/v1/embeddings";
const MODEL = "jina-clip-v2";
const FAKE_MODEL = `${MODEL}-fake`;

/** Şema `vector(768)` taahhüt ediyor. */
export const EMBEDDING_DIMENSIONS = 768;

const MAX_RETRIES = 4;

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

/** `docs/decisions/0015` ile aynı istisna: istek yolundaki tek model çağrısı. */
export class JinaEmbeddingClient implements EmbeddingClient {
  readonly modelVersion = MODEL;

  constructor(private readonly apiKey: string) {}

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

  private async postWithRetry(body: unknown): Promise<unknown> {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 || response.status >= 500) {
        if (attempt === MAX_RETRIES - 1) {
          throw new EmbeddingError(
            `sağlayıcı ${response.status} döndü, ${MAX_RETRIES} denemede geçmedi`,
          );
        }
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (response.status >= 400) {
        const text = await response.text();
        throw new EmbeddingError(`sağlayıcı ${response.status}: ${text.slice(0, 200)}`);
      }
      return response.json();
    }
    throw new EmbeddingError("beklenmeyen durum: yeniden deneme döngüsü bitti");
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

/** `JINA_API_KEY` boşsa sahte istemciye düşer - B3'ün `--fake-client` emsali. */
export function getEmbeddingClient(): EmbeddingClient {
  const apiKey = process.env.JINA_API_KEY;
  return apiKey ? new JinaEmbeddingClient(apiKey) : new FakeEmbeddingClient();
}
