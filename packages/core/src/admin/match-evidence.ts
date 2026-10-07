/**
 * Eşleştirme kuyruğu kanıtı (docs/decisions/0053). SAF fonksiyonlar —
 * veritabanı yok. Moderatöre "bu skor ne demek, neden insan bekliyor,
 * kimlikler uyuşuyor mu?" sorusunu resolver'ın GERÇEK kurallarıyla cevaplar:
 *
 * - skor ve eşikler: `services/ingest/resolve/score.py` (`combine`,
 *   `auto_eligible`, `queue_threshold`, `auto_accept_threshold`)
 * - inceleme nedeni (`review`): `score.unverified_color` (0029) ve
 *   `identifiers.unverified_variant_volume` (0033)
 * - barkod vetosu: `score.veto_reason` (iki geçerli farklı barkod) ve
 *   `identifiers.disjoint_barcode_products` (tam barkod kümesi, 0036)
 *
 * Kayıtta olmayan bir bileşen (ör. görsel benzerliği) uydurulmaz; eski
 * satırlarda `explain` yoktur ve öyle söylenir.
 */
import type { MatchExplain } from "./matching-queue.ts";

/** score.py varsayılanları (docs/decisions/0017). Satırın kendi eşikleri öncelikli. */
export const MATCH_QUEUE_THRESHOLD = 0.63;
export const MATCH_AUTO_ACCEPT_THRESHOLD = 0.84;
/** score.py `BRAND_AGREEMENT_BONUS`. */
export const BRAND_AGREEMENT_BONUS = 0.08;

export type ScorePosition = "below_queue" | "review_band" | "auto_band";

export interface ScoreBand {
  score: number;
  queueThreshold: number;
  autoAcceptThreshold: number;
  /** Eşikler satırın `explain`inden mi geldi, yoksa bugünkü varsayılan mı. */
  thresholdsFrom: "explain" | "default";
  position: ScorePosition;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function scoreBand(score: number, explain: MatchExplain | null): ScoreBand {
  const fromExplain =
    explain !== null && finite(explain.queue_threshold) && finite(explain.auto_accept_threshold);
  const queueThreshold = fromExplain ? (explain.queue_threshold as number) : MATCH_QUEUE_THRESHOLD;
  const autoAcceptThreshold = fromExplain
    ? (explain.auto_accept_threshold as number)
    : MATCH_AUTO_ACCEPT_THRESHOLD;
  const position: ScorePosition =
    score < queueThreshold
      ? "below_queue"
      : score >= autoAcceptThreshold
        ? "auto_band"
        : "review_band";
  return {
    score,
    queueThreshold,
    autoAcceptThreshold,
    thresholdsFrom: fromExplain ? "explain" : "default",
    position,
  };
}

export type SignalTone = "supports" | "weakens" | "neutral";

export interface EvidenceSignal {
  key: string;
  tone: SignalTone;
  text: string;
}

function fmt(n: number): string {
  return n.toFixed(2).replace(".", ",");
}

/**
 * `review` metni Python'dan gelir ("renk dogrulanamadi: …", "hacim varyanti
 * dogrulanamadi: …"). Bilinen önekler açıklanır; bilinmeyen metin olduğu gibi
 * kalır (makine notu, kişisel veri değil).
 */
export function reviewReasonText(review: string): string {
  const raw = review.slice(0, 200);
  if (raw.startsWith("renk dogrulanamadi")) {
    return `Renk yalnızca bir tarafta biliniyor ve öbür tarafın başlığında geçmiyor (karar 0029). Ürün renk düzeyinde kanonik olduğu için renk doğrulanmadan otomatik kabul yapılmaz. Resolver notu: ${raw}`;
  }
  if (raw.startsWith("hacim varyanti dogrulanamadi")) {
    return `Teklifin hacmi, adaya bağlı aktif tekliflerin bilinen hacimleri arasında yok (karar 0033). Aynı ürün ailesi olabilir ama aynı satılabilir varyant olduğu kanıtlanmadı. Resolver notu: ${raw}`;
  }
  return `Resolver notu: ${raw}`;
}

/**
 * Skoru destekleyen / zayıflatan bileşenler. Yalnızca `explain`te kayıtlı
 * alanlar ve score.py'nin formülü kullanılır.
 */
export function explainSignals(
  method: string,
  score: number,
  explain: MatchExplain | null,
): EvidenceSignal[] {
  const signals: EvidenceSignal[] = [];
  if (method === "gtin" || method === "mpn") {
    signals.push({
      key: "exact",
      tone: "supports",
      text: `Kesin kimlik (${method === "gtin" ? "barkod" : "MPN"}) eşleşmesi: skor 1,00.`,
    });
  }
  if (!explain) return signals;
  const band = scoreBand(score, explain);

  if (finite(explain.text_similarity)) {
    const text = explain.text_similarity;
    signals.push({
      key: "text",
      tone:
        text >= band.autoAcceptThreshold
          ? "supports"
          : text < band.queueThreshold
            ? "weakens"
            : "neutral",
      text: `Başlık benzerliği ${fmt(text)}: başlık kelime kümelerinin ortak oranı${
        explain.brand_equal ? ` + ${fmt(BRAND_AGREEMENT_BONUS)} marka uyumu` : ""
      } (renk, hacim ve marka kelimeleri ayrı denetlenir).`,
    });
  }
  if (method === "hybrid") {
    signals.push({
      key: "hybrid",
      tone: "neutral",
      text: "Hibrit skor = 0,6 × başlık + 0,4 × görsel (ikisi de 0,60 ve üstündeyse +0,06). Görsel benzerliği ayrıca kaydedilmez.",
    });
  } else if (method === "text" && finite(explain.text_similarity)) {
    signals.push({
      key: "text_only",
      tone: "neutral",
      text: `Skor yalnızca başlıktan (${fmt(score)}); görsel sinyal kullanılmadı.`,
    });
  }

  if (explain.brand_known_both === undefined && explain.brand_equal === undefined) {
    // eski açıklama sürümü: marka alanı yok
  } else if (explain.brand_equal) {
    signals.push({ key: "brand", tone: "supports", text: "Marka iki tarafta aynı." });
  } else if (explain.brand_known_both) {
    signals.push({
      key: "brand",
      tone: "weakens",
      text: "Marka iki tarafta biliniyor ve farklı. Resolver bunu bugün veto eder; satır eski olabilir.",
    });
  } else {
    signals.push({
      key: "brand",
      tone: "weakens",
      text: "Marka en az bir tarafta bilinmiyor: otomatik kabul için iki tarafta aynı marka şart (karar 0034).",
    });
  }

  if (explain.review) {
    signals.push({ key: "review", tone: "weakens", text: reviewReasonText(explain.review) });
  }
  return signals;
}

/**
 * Neden insan bekliyor: score.py `auto_eligible`'ın ters çevrilmiş hali.
 * `auto_eligible` = veto/`review` yok VE (kesin kimlik YA DA skor ≥ eşik VE
 * marka iki tarafta aynı).
 */
export function humanReviewReasons(
  method: string,
  score: number,
  explain: MatchExplain | null,
): string[] {
  if (!explain) {
    return [
      "Bu satırın skor açıklaması yok (açıklama kaydı başlamadan üretilmiş). Yalnızca skor ve yöntem biliniyor.",
    ];
  }
  const band = scoreBand(score, explain);
  const reasons: string[] = [];
  if (explain.review) reasons.push(reviewReasonText(explain.review));
  if (method !== "gtin" && method !== "mpn") {
    if (score < band.autoAcceptThreshold) {
      reasons.push(
        `Skor ${fmt(score)}, otomatik kabul eşiğinin (${fmt(band.autoAcceptThreshold)}) altında.`,
      );
    }
    if (explain.brand_equal === false) {
      reasons.push(
        explain.brand_known_both
          ? "Markalar farklı."
          : "Marka iki tarafta bilinmediği için skor ne olursa olsun otomatik kabul yapılmaz.",
      );
    }
  }
  if (reasons.length === 0 && explain.auto_eligible) {
    reasons.push(
      "Açıklama satırı otomatik kabule uygun diyor; satır eşik değişikliğinden önce üretilmiş olabilir.",
    );
  }
  if (reasons.length === 0) reasons.push("Kayıtlı açıklamadan kesin bir neden çıkarılamadı.");
  return reasons;
}

export type IdentifierState = "equal" | "conflict" | "different" | "missing";

export interface IdentifierCheck {
  state: IdentifierState;
  text: string;
  shared: string[];
}

export interface IdentifierInput {
  offer: { gtin: string | null; mpn: string | null; variantGtins: readonly string[] };
  product: { gtin: string | null; mpn: string | null };
  /** Adaya bağlı AKTİF tekliflerin teklif + varyant barkodları. */
  candidateGtins: readonly string[];
  /** Adayın her aktif teklifi barkodlu mu (identifiers.CANDIDATE_GTIN_SETS). */
  candidateGtinSetComplete: boolean;
  siblingMpns: readonly string[];
}

function clean(values: readonly (string | null | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const v = (value ?? "").trim();
    if (v) out.add(v);
  }
  return out;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x)).sort();
}

export function identifierAgreement(input: IdentifierInput): {
  gtin: IdentifierCheck;
  mpn: IdentifierCheck;
} {
  const offerGtins = clean([input.offer.gtin, ...input.offer.variantGtins]);
  const candidateGtins = clean([input.product.gtin, ...input.candidateGtins]);
  let gtin: IdentifierCheck;
  if (offerGtins.size === 0 || candidateGtins.size === 0) {
    gtin = {
      state: "missing",
      shared: [],
      text:
        offerGtins.size === 0 && candidateGtins.size === 0
          ? "Barkod iki tarafta da yok."
          : offerGtins.size === 0
            ? "Teklifte barkod yok."
            : "Adayda (ürün ve bağlı teklifler) barkod yok.",
    };
  } else {
    const shared = intersect(offerGtins, candidateGtins);
    const offerLevel = (input.offer.gtin ?? "").trim();
    const productLevel = (input.product.gtin ?? "").trim();
    if (shared.length > 0) {
      gtin = {
        state: "equal",
        shared: shared.slice(0, 3),
        text: `Ortak barkod: ${shared.slice(0, 3).join(", ")}.`,
      };
    } else if (offerLevel && productLevel && offerLevel !== productLevel) {
      gtin = {
        state: "conflict",
        shared: [],
        text: `Teklif barkodu ${offerLevel}, ürün barkodu ${productLevel}: iki farklı barkod farklı üründür (resolver vetosu, karar 0034).`,
      };
    } else if (input.candidateGtinSetComplete) {
      gtin = {
        state: "conflict",
        shared: [],
        text: "Adayın barkod kümesi tam ve teklifin hiçbir barkodunu içermiyor: resolver bu adayı bugün eler (karar 0036).",
      };
    } else {
      gtin = {
        state: "different",
        shared: [],
        text: "Barkodlar ortak değil ama adayın bazı tekliflerinde barkod yok; teklif adayın listelenmemiş bir boyutu olabilir.",
      };
    }
  }

  const offerMpn = (input.offer.mpn ?? "").trim();
  const candidateMpns = clean([input.product.mpn, ...input.siblingMpns]);
  let mpn: IdentifierCheck;
  if (!offerMpn || candidateMpns.size === 0) {
    mpn = {
      state: "missing",
      shared: [],
      text: !offerMpn ? "Teklifte MPN yok." : "Adayda MPN yok.",
    };
  } else if (candidateMpns.has(offerMpn)) {
    mpn = { state: "equal", shared: [offerMpn], text: `Ortak MPN: ${offerMpn}.` };
  } else {
    mpn = {
      state: "different",
      shared: [],
      text: "MPN'ler farklı (resolver MPN farkını veto saymaz; yalnızca eşitlik kesin kanıttır).",
    };
  }
  return { gtin, mpn };
}

/** Bekleme süresi, kaba: "3 gün", "5 saat", "12 dakika". */
export function waitedText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} dakika`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} saat`;
  return `${Math.floor(hours / 24)} gün`;
}
