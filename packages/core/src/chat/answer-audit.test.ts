/**
 * Karar 0212: insan denetimiyle (15 Kas 2026 pilotu, 134 cevap) bulunan kalıplar ve etiketli küme
 * üzerinde regresyon. Etiketler `docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json`
 * içindedir (insan onaylı); bu test model çağırmaz, kayıtlı ham paragrafları yeniden doğrular.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { factsForCase, PILOT_CASES } from "../eval/chat-answer-pilot-cases.ts";
import { answerText, type ResultFact, validateAnswer } from "./answer.ts";
import { CHAT_INSTRUCTIONS } from "./interpreter.ts";

const FACTS: ResultFact[] = [
  {
    id: "p1",
    title: "Fidget Pop It Silikon Duyusal Oyuncak",
    brand: "Philips",
    store: "Trendyol",
    price_try: 89,
    offer_count: 8,
  },
];
const check = (text: string, question?: string) =>
  validateAnswer(
    { paragraphs: [{ text, evidence: [{ item: "p1", field: "brand", quote: "Philips" }] }] },
    FACTS,
    question ? { question } : {},
  );

describe("inference patterns confirmed by the human audit", () => {
  it("rejects need-assuming framing, non-price comparatives, made-for/effect and capability claims", () => {
    for (const text of [
      "Daha hafif veya manyetik bir çözüm arıyorsanız bu ürün Hepsiburada listesinde yer alıyor.",
      "Oyun ekipmanlarını düzenli tutmak istersen bu klavye Trendyol listesinde yer alıyor burada.",
      "Dizüstü bilgisayar şarjı gibi ihtiyaçlarınız varsa bu model Hepsiburada listesinde bulunuyor.",
      "Eveline spreyi daha hafif bir tercih olarak Trendyol listesinde 249 TL fiyatla yer alıyor.",
      "Bu mama yavru kedilerin beslenme gereksinimlerini karşılamak üzere geliştirilmiştir burada.",
      "Bu besleyici beslenme takibi yapmanıza yardımcı olabilir ve Trendyol listesinde yer alıyor.",
      "Taşıma ve depolama için özel üretilmiş çantalar bu listede Trendyol üzerinde yer alıyor.",
      "Bu saat iPhone ile eşleşebilen ve bildirimleri yönetebilen bir akıllı saat olarak listelenmiş.",
      "Spigen kılıf 699 TL fiyatıyla orta segmentte yer alırken diğeri Trendyol listesinde bulunuyor.",
      "Adidas Samba modelleri günlük kullanım için klasik bir seçenek olarak öne çıkıyor burada.",
      "Sınav stresi için değerlendirebileceğiniz bir seçenek Trendyol üzerinde satışa sunulan modeldir.",
      "Oyun deneyimini geliştirmek için bu oyun kolu Hepsiburada listesinde yer alıyor burada.",
    ]) {
      const verdict = check(text);
      expect(verdict.answer, text).toBeNull();
      expect(verdict.rejected[0], text).toBe("forbidden_claim");
    }
  });

  it("keeps price, offer-count and title-backed statements that look similar", () => {
    for (const text of [
      "Philips ürünü daha uygun fiyatlı seçenek olarak Trendyol listesinde yer alıyor burada.",
      "Philips ürünü daha düşük fiyatla ve daha fazla teklifle Trendyol listesinde yer alıyor.",
      "Fidget Pop It oyuncak silikon malzemeden üretilmiş olup Trendyol listesinde yer alıyor.",
      "Philips ürünü daha yüksek fiyatlı seçenek olarak Trendyol listesinde yer alıyor burada.",
    ]) {
      expect(check(text).rejected, text).toEqual([]);
    }
  });

  it("allows the same words when the clause says the data is absent", () => {
    expect(
      check("Başlıklarda hangisinin daha hafif olduğuna dair bir bilgi belirtilmemiş durumda.")
        .rejected,
    ).toEqual([]);
  });

  it("rejects claims about sources the model never received, even as an absence statement", () => {
    const verdict = check(
      "Ürünlerin başlıklarında veya açıklamalarında veteriner onayına dair bir bilgi bulunmamaktadır.",
    );
    expect(verdict.rejected).toEqual(["forbidden_claim"]);
  });
});

describe("prompt carries the audit lessons (effect unmeasured until the next model run)", () => {
  it("tells the model to check every title before claiming absence and to answer the asked criterion", () => {
    expect(CHAT_INSTRUCTIONS).toMatch(/OLMADIĞINI söylemeden önce TÜM başlıkları kontrol et/);
    expect(CHAT_INSTRUCTIONS).toMatch(/en düşük TL fiyatlı ürünü adıyla açıkça belirt/);
    expect(CHAT_INSTRUCTIONS).toMatch(/ayırt edici bir bilgi belirtilmemiş/);
  });
});

// ---------------------------------------------------------------------------
// Etiketli küme: kayıtlı ham model çıktısı + insan kararı
// ---------------------------------------------------------------------------

interface LabelledRecord {
  id: string;
  caseId?: string;
  question: string;
  shownText: string;
  rawParagraphs: { text: string; evidence: { item: string; field: string; quote: string }[] }[];
  review: { verdict: "correct" | "unevidenced_claim" | "wrong" | "off_intent" | null };
}

const audit = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        "../../../../docs/eval-data/chat-answer-pilot/2026-11-15-full/audit.json",
        import.meta.url,
      ),
    ),
    "utf8",
  ),
) as { records: LabelledRecord[] };
const labelled = audit.records.filter((record) => record.review.verdict !== null);

function revalidate(record: LabelledRecord): string | null {
  const testCase = PILOT_CASES.find((c) => c.id === (record.caseId ?? record.id));
  if (!testCase) throw new Error(record.id);
  const verdict = validateAnswer(
    { paragraphs: record.rawParagraphs.map(({ text, evidence }) => ({ text, evidence })) },
    factsForCase(testCase),
    { question: record.question },
  );
  return verdict.answer ? answerText(verdict.answer) : null;
}

const ids = (verdict: string, keep: (kept: string | null, shown: string) => boolean) =>
  labelled
    .filter((r) => r.review.verdict === verdict && keep(revalidate(r), r.shownText))
    .map((r) => r.id)
    .sort();

describe("labelled pilot set (134 human-reviewed answers)", () => {
  it("has the reviewed verdict counts", () => {
    const count = (v: string) => labelled.filter((r) => r.review.verdict === v).length;
    expect(labelled).toHaveLength(134);
    expect([
      count("correct"),
      count("unevidenced_claim"),
      count("wrong"),
      count("off_intent"),
    ]).toEqual([96, 15, 5, 18]);
  });

  it("no answer judged 'unevidenced claim' is shown unchanged any more", () => {
    expect(ids("unevidenced_claim", (kept, shown) => kept === shown)).toEqual([]);
  });

  it("answers judged correct survive (one known loss: a title-backed 'geniş kapasiteli')", () => {
    expect(ids("correct", (kept, shown) => kept !== shown)).toEqual(["backpack-01"]);
  });

  it("KNOWN GAP: two false 'no title mentions X' answers still pass; word rules cannot verify absence", () => {
    // Başlıkta bilgi varken "hiçbirinde yok" diyen cevaplar. Düzeltmek için başlıktan çıkarılmış
    // yapılandırılmış öznitelik gerekir (Faz 8). Bu test açık kalan riski görünür tutar; kapanırsa
    // liste kısalır ve test bilinçli olarak güncellenir.
    // `powerbank-06` (iPhone 16) ve `women_fashion-04` (Cotton) karar 0213 ile yakalandı.
    expect(ids("wrong", (kept, shown) => kept === shown)).toEqual(["desk_lamp-04", "fidget-04"]);
  });
});

describe("prompt carries the price and comparison rules (effect unmeasured until a model run)", () => {
  it("states approximate-price, date, shipping/tax and comparison rules", () => {
    expect(CHAT_INSTRUCTIONS).toMatch(/price_approx true ise/);
    expect(CHAT_INSTRUCTIONS).toMatch(/yoksa hiçbir tarih söyleme/);
    expect(CHAT_INSTRUCTIONS).toMatch(/Kargo, vergi, gümrük ve toplam maliyet/);
    expect(CHAT_INSTRUCTIONS).toMatch(/yalnız fiyat sıralaması verme/);
  });
});
