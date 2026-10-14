/**
 * H9 olcumu: Gemini URL Context (ve istege bagli Google Search grounding) Trendyol urun
 * sayfasini okuyup GERCEK fiyati verebiliyor mu? (arastirma; docs/research/trendyol-search/14)
 *
 * Yalnizca ucretsiz katman (Google AI Studio, faturalandirma kapali proje) icin tasarlandi:
 * - model `gemini-2.5-flash` (ucretsiz katmanda URL Context + gunde 500 grounding istegi);
 * - anahtar ayri bir degiskenden okunur ve production anahtariyla esitse REDDEDILIR;
 * - her istek tek deneme; 429 gorulunce olcum durur (ucretsiz kota bitti, ucretli istek yok).
 *
 * Model ciktisi guvenilmez veridir. Bir fiyat ancak (1) URL Context sayfayi BASARIYLA okuduysa,
 * (2) model kanit metninde ayni tutari verdiyse ve (3) ayni dakikalarda gercek tarayicida
 * kaydedilen yer gercegiyle karsilastirildiysa "dogru" sayilir. Kanit metni modelin kendisinden
 * geldigi icin (2) tek basina dogrulama DEGILDIR; yalnizca (3) dogruluk olcer.
 */

import { createHash } from "node:crypto";
import { parsePricesKurus } from "../web-search/parse.ts";
import type { PriceKind, PriceObservation } from "./price-observation.ts";

export const GEMINI_FREE_MODEL = "gemini-2.5-flash";
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_FREE_MODEL}:generateContent`;

type Env = Readonly<Record<string, string | undefined>>;

export interface FreeTierGate {
  ready: boolean;
  reason: string | null;
  apiKey: string | null;
}

const sha = (s: string) => createHash("sha256").update(s.trim()).digest("hex");

/**
 * `TRENDYOL_GEMINI_FREE_TIER=1` + `GEMINI_FREE_TIER_API_KEY`. `productionKeys` production
 * ortam dosyalarindan okunan anahtarlardir; yalnizca ozetleri karsilastirilir, yazdirilmaz.
 */
export function freeTierGate(env: Env, productionKeys: readonly string[]): FreeTierGate {
  if (env.TRENDYOL_GEMINI_FREE_TIER !== "1") {
    return { ready: false, reason: "TRENDYOL_GEMINI_FREE_TIER!=1", apiKey: null };
  }
  const key = env.GEMINI_FREE_TIER_API_KEY?.trim();
  if (!key) return { ready: false, reason: "GEMINI_FREE_TIER_API_KEY yok", apiKey: null };
  const prod = new Set(productionKeys.filter((k) => k.trim()).map(sha));
  if (prod.has(sha(key))) {
    return {
      ready: false,
      reason: "anahtar production anahtariyla ayni: reddedildi",
      apiKey: null,
    };
  }
  return { ready: true, reason: null, apiKey: key };
}

/** `.env` biciminden yalnizca GEMINI_API_KEY degerlerini ayiklar (deger loglanmaz). */
export function geminiKeysFromEnvText(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*["']?([^"'\s#]+)/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return keys;
}

export type ProbeMode = "url_context" | "search_and_url_context";

export function buildPrompt(mode: ProbeMode, target: { url?: string; query?: string }): string {
  const schema =
    '{"pages":[{"url":string,"title":string|null,"seller":string|null,' +
    '"price":{"amount":number,"currency":"TRY","evidence":string}|null,' +
    '"originalPrice":{"amount":number,"evidence":string}|null,' +
    '"inStock":boolean|null,"variant":string|null}]}';
  const rules =
    "Kurallar: yalnizca okudugun sayfadaki bilgiyi yaz; tahmin etme. `evidence` sayfadan " +
    "BIREBIR kopyalanmis, tutari iceren kisa metin olmali. Sayfada fiyat yoksa price=null. " +
    "Sayfayi okuyamadiysan pages=[]. Yalnizca JSON dondur.";
  if (mode === "url_context") {
    return `Su Trendyol urun sayfasini oku: ${target.url}\nCikti bicimi: ${schema}\n${rules}`;
  }
  return (
    `Trendyol'da (www.trendyol.com) su urunu bul ve urun sayfalarini oku: "${target.query}". ` +
    `En fazla 5 urun sayfasi.\nCikti bicimi: ${schema}\n${rules}`
  );
}

export function buildRequestBody(mode: ProbeMode, prompt: string): string {
  return JSON.stringify({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    tools:
      mode === "url_context" ? [{ url_context: {} }] : [{ google_search: {} }, { url_context: {} }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  });
}

export interface ProbePage {
  url: string;
  title: string | null;
  seller: string | null;
  priceKurus: number | null;
  /** Kanit metni ayni tutari iceriyor mu (modelin oz-tutarliligi; dogruluk DEGIL). */
  evidenceConsistent: boolean;
  originalPriceKurus: number | null;
  inStock: boolean | null;
  variant: string | null;
}

export interface ProbeResult {
  ok: boolean;
  failure: string | null;
  httpStatus: number | null;
  latencyMs: number;
  /** URL Context okuma durumlari (adres + saglayici durumu). */
  retrieved: { url: string; status: string }[];
  /** Grounding kaynaklarinin adresleri (yonlendirme adresleri olabilir). */
  groundingUris: string[];
  pages: ProbePage[];
  tokens: { prompt: number; toolUse: number; output: number };
  /** Yanit seklinin anahtar adlari (icerik yok). */
  shape: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const s = body.indexOf("{");
  const e = body.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(body.slice(s, e + 1));
  } catch {
    return null;
  }
}

function moneyKurus(v: unknown): { kurus: number; evidence: string } | null {
  if (!isRecord(v) || typeof v.amount !== "number" || !Number.isFinite(v.amount) || v.amount <= 0) {
    return null;
  }
  if (v.amount >= 10_000_000) return null;
  return {
    kurus: Math.round(v.amount * 100),
    evidence: typeof v.evidence === "string" ? v.evidence.slice(0, 300) : "",
  };
}

const str = (v: unknown, max = 300) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

/** generateContent yanitini ayristirir. Sayfa metnine guvenilmez; yalnizca bilinen alanlar okunur. */
export function parseGenerateContent(
  payload: unknown,
): Omit<ProbeResult, "latencyMs" | "httpStatus"> {
  const empty = {
    retrieved: [],
    groundingUris: [],
    pages: [],
    tokens: { prompt: 0, toolUse: 0, output: 0 },
  };
  if (!isRecord(payload)) return { ok: false, failure: "malformed", shape: [], ...empty };
  const shape = Object.keys(payload).slice(0, 20);
  const cand = Array.isArray(payload.candidates) ? payload.candidates[0] : null;
  if (!isRecord(cand)) return { ok: false, failure: "no_candidate", shape, ...empty };
  shape.push(...Object.keys(cand).map((k) => `candidate.${k}`));

  const usage = isRecord(payload.usageMetadata) ? payload.usageMetadata : {};
  const n = (v: unknown) => (typeof v === "number" && v >= 0 ? v : 0);
  const tokens = {
    prompt: n(usage.promptTokenCount),
    toolUse: n(usage.toolUsePromptTokenCount),
    output: n(usage.candidatesTokenCount),
  };

  const retrieved: { url: string; status: string }[] = [];
  const ucm = isRecord(cand.urlContextMetadata) ? cand.urlContextMetadata : null;
  for (const m of Array.isArray(ucm?.urlMetadata) ? ucm.urlMetadata : []) {
    if (
      isRecord(m) &&
      typeof m.retrievedUrl === "string" &&
      typeof m.urlRetrievalStatus === "string"
    ) {
      retrieved.push({ url: m.retrievedUrl, status: m.urlRetrievalStatus });
    }
  }
  const groundingUris: string[] = [];
  const gm = isRecord(cand.groundingMetadata) ? cand.groundingMetadata : null;
  for (const c of Array.isArray(gm?.groundingChunks) ? gm.groundingChunks : []) {
    if (isRecord(c) && isRecord(c.web) && typeof c.web.uri === "string")
      groundingUris.push(c.web.uri);
  }

  const content = isRecord(cand.content) ? cand.content : null;
  const text = (Array.isArray(content?.parts) ? content.parts : [])
    .map((p) => (isRecord(p) && typeof p.text === "string" ? p.text : ""))
    .join("");
  const root = extractJson(text);
  const list = isRecord(root) && Array.isArray(root.pages) ? root.pages.slice(0, 10) : [];
  const pages: ProbePage[] = [];
  for (const raw of list) {
    if (!isRecord(raw) || typeof raw.url !== "string") continue;
    const price = moneyKurus(raw.price);
    const original = moneyKurus(raw.originalPrice);
    pages.push({
      url: raw.url.slice(0, 2048),
      title: str(raw.title),
      seller: str(raw.seller, 120),
      priceKurus: price?.kurus ?? null,
      evidenceConsistent: price ? parsePricesKurus(price.evidence).includes(price.kurus) : false,
      originalPriceKurus: original?.kurus ?? null,
      inStock: typeof raw.inStock === "boolean" ? raw.inStock : null,
      variant: str(raw.variant, 120),
    });
  }
  const finish = typeof cand.finishReason === "string" ? cand.finishReason : null;
  return {
    ok: text.length > 0,
    failure: text.length > 0 ? null : `empty_text${finish ? `:${finish}` : ""}`,
    retrieved,
    groundingUris,
    pages,
    tokens,
    shape,
  };
}

export async function probe(
  apiKey: string,
  mode: ProbeMode,
  target: { url?: string; query?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: buildRequestBody(mode, buildPrompt(mode, target)),
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    return failed("network", null, started);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return failed(`http_${res.status}`, res.status, started);
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    return failed("malformed", res.status, started);
  }
  return {
    ...parseGenerateContent(payload),
    httpStatus: res.status,
    latencyMs: Date.now() - started,
  };
}

function failed(failure: string, httpStatus: number | null, started: number): ProbeResult {
  return {
    ok: false,
    failure,
    httpStatus,
    latencyMs: Date.now() - started,
    retrieved: [],
    groundingUris: [],
    pages: [],
    tokens: { prompt: 0, toolUse: 0, output: 0 },
    shape: [],
  };
}

const PRODUCT_ID = /-p-(\d+)(?:[/?#]|$)/;

export function contentIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "www.trendyol.com") return null;
    return PRODUCT_ID.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

export interface TruthComparison {
  contentId: string;
  retrievedOk: boolean;
  priceReturned: boolean;
  evidenceConsistent: boolean;
  /** Ayni urunun yer gercegi gozlemi var mi (zaman penceresi icinde). */
  truthAvailable: boolean;
  /** Model fiyatinin esit oldugu yer gercegi katmanlari (bos = hicbiri). */
  matchedKinds: PriceKind[];
  /** Sayfada gorunen musteri fiyatiyla (page.discounted) birebir esit mi. */
  matchesDisplayed: boolean | null;
  sellerMatches: boolean | null;
  absDiffKurus: number | null;
}

const norm = (s: string) =>
  s
    .toLocaleLowerCase("tr")
    .replace(/ı/g, "i")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Model gozlemini AYNI urunun tarayici gozlemleriyle karsilastirir. Yer gercegi model cagrisina
 * `windowMin` dakikadan uzaksa karsilastirilmaz (farkli zamanlar esit varsayilmaz).
 */
export function compareWithTruth(
  contentId: string,
  result: ProbeResult,
  probedAt: string,
  truth: readonly PriceObservation[],
  truthSeller: string | null,
  windowMin = 10,
): TruthComparison {
  const page = result.pages.find((p) => contentIdOf(p.url) === contentId) ?? null;
  const retrievedOk = result.retrieved.some(
    (r) => contentIdOf(r.url) === contentId && /SUCCESS/i.test(r.status),
  );
  const t0 = Date.parse(probedAt);
  const near = truth.filter(
    (o) =>
      o.contentId === contentId &&
      o.kind.startsWith("page.") &&
      Math.abs(Date.parse(o.observedAt) - t0) <= windowMin * 60_000,
  );
  const price = page?.priceKurus ?? null;
  const matchedKinds =
    price === null ? [] : near.filter((o) => o.priceKurus === price).map((o) => o.kind);
  const displayed = near.find((o) => o.kind === "page.discounted") ?? null;
  return {
    contentId,
    retrievedOk,
    priceReturned: price !== null,
    evidenceConsistent: page?.evidenceConsistent ?? false,
    truthAvailable: near.length > 0,
    matchedKinds,
    matchesDisplayed: price === null || displayed === null ? null : displayed.priceKurus === price,
    sellerMatches:
      page?.seller && truthSeller
        ? norm(page.seller).includes(norm(truthSeller)) ||
          norm(truthSeller).includes(norm(page.seller))
        : null,
    absDiffKurus:
      price === null || displayed === null ? null : Math.abs(displayed.priceKurus - price),
  };
}
