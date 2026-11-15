import { describe, expect, it } from "vitest";
import {
  answerText,
  fallbackAnswerText,
  looksLikeResultQuestion,
  type ResultFact,
  toResultFacts,
  validateAnswer,
} from "./answer.ts";
import { isChatAnswerEnabled } from "./config.ts";

const FACTS: ResultFact[] = [
  {
    id: "p1",
    title: "Philips Hue Masa Lambası 9 W Beyaz",
    brand: "Philips",
    store: "Hepsiburada",
    price_try: 1299,
    offer_count: 3,
  },
  {
    id: "p2",
    title: "Xiaomi LED Masa Lambası Şarjlı",
    brand: "Xiaomi",
    store: "Trendyol",
    price_try: 799,
    offer_count: 1,
  },
  {
    id: "p3",
    title: "Okuma Lambası Klipsli",
    brand: null,
    store: null,
    price_try: null,
    offer_count: null,
  },
];

const ok = (paragraphs: unknown[]) => validateAnswer({ paragraphs }, FACTS);
const para = (text: string, evidence: unknown[]) => ({ text, evidence });
const ev = (item: string, field: string, quote: string) => ({ item, field, quote });

describe("validateAnswer", () => {
  it("keeps a paragraph whose every claim is backed by a quote", () => {
    const verdict = ok([
      para("Philips Hue ürünü Hepsiburada'da 1.299 TL; Xiaomi ise Trendyol'da 799 TL.", [
        ev("p1", "brand", "Philips"),
        ev("p1", "store", "Hepsiburada"),
        ev("p1", "price", "1299"),
        ev("p2", "price", "799"),
      ]),
    ]);
    expect(verdict.rejected).toEqual([]);
    expect(verdict.answer?.paragraphs).toHaveLength(1);
    expect(answerText(verdict.answer!)).toContain("1.299 TL");
  });

  it("accepts title specs only when quoted from the title (9 W comes from the title)", () => {
    const verdict = ok([
      para("Philips modelin başlığında 9 W ifadesi geçiyor, renk olarak beyaz belirtilmiş.", [
        ev("p1", "title", "9 W Beyaz"),
      ]),
    ]);
    expect(verdict.answer).not.toBeNull();
  });

  it("rejects a number that no quote supports (invented spec or price)", () => {
    const verdict = ok([
      para("Philips lambası 1.299 TL ve 12 saat pil ömrü sunuyor diye belirtilmiş görünüyor.", [
        ev("p1", "price", "1299"),
      ]),
    ]);
    expect(verdict.answer).toBeNull();
    expect(verdict.rejected).toEqual(["unevidenced_number"]);
  });

  it("rejects a quote that is not in the fact, a wrong price and an unknown product", () => {
    expect(
      ok([
        para("Philips ürünü marka olarak öne çıkıyor ve listede yer alıyor.", [
          ev("p1", "brand", "Bosch"),
        ]),
      ]).rejected,
    ).toContain("quote_mismatch");
    expect(
      ok([
        para("Philips ürünü Hepsiburada mağazasında listelenmiş durumda.", [
          ev("p1", "price", "999"),
        ]),
      ]).rejected,
    ).toContain("quote_mismatch");
    expect(
      ok([
        para("Bu ürün hakkında bilgi veriyoruz ve marka bilgisini paylaşıyoruz.", [
          ev("p9", "brand", "Philips"),
        ]),
      ]).answer,
    ).toBeNull();
  });

  it("rejects fields the fact does not have (brand/store/price null)", () => {
    expect(
      ok([
        para("Okuma lambasının markası belirtilmemiş ama listede yer alıyor.", [
          ev("p3", "brand", "Philips"),
        ]),
      ]).answer,
    ).toBeNull();
    expect(
      ok([
        para("Okuma lambasının fiyatı listelenmiş durumda yer alıyor burada.", [
          ev("p3", "price", "100"),
        ]),
      ]).answer,
    ).toBeNull();
  });

  it("rejects unverifiable quality, performance, compatibility and marketing claims", () => {
    for (const text of [
      "Philips Hue en iyi masa lambası seçeneği olarak öne çıkıyor bu listede.",
      "Xiaomi lambası daha kaliteli ve dayanıklı bir ürün gibi görünüyor burada.",
      "Philips modelin performansı çok yüksek ve hızlı çalışıyor listede.",
      "Bu lambalar telefonla uyumlu çalışıyor ve kullanışlı görünüyor listede.",
      "Xiaomi daha ucuz bir seçenek sunuyor ve fiyatı düşük görünüyor burada.",
    ]) {
      const verdict = ok([para(text, [ev("p1", "brand", "Philips")])]);
      expect(verdict.answer, text).toBeNull();
      expect(verdict.rejected[0]).toBe("forbidden_claim");
    }
  });

  it("rejects paragraphs without evidence, URLs, shouting and bad length", () => {
    expect(
      ok([para("Philips ürünü Hepsiburada mağazasında listelenmiş durumda yer alıyor.", [])])
        .rejected,
    ).toEqual(["no_evidence"]);
    expect(ok([para("Kısa", [ev("p1", "brand", "Philips")])]).rejected).toEqual(["length"]);
    expect(
      ok([
        para("Philips ürününü https://x.test adresinden görebilirsin ve inceleyebilirsin.", [
          ev("p1", "brand", "Philips"),
        ]),
      ]).rejected,
    ).toEqual(["url"]);
    expect(
      ok([
        para("PHILIPS markası listede yer alıyor ve mağaza bilgisi de bulunuyor burada.", [
          ev("p1", "brand", "Philips"),
        ]),
      ]).rejected,
    ).toEqual(["all_caps"]);
  });

  it("keeps the good paragraphs and drops the bad ones; caps at three", () => {
    const good = para("Xiaomi ürünü Trendyol mağazasında listelenmiş durumda yer alıyor.", [
      ev("p2", "store", "Trendyol"),
    ]);
    const bad = para("Philips modeli en iyi seçenek olarak görünüyor listede yer alıyor.", [
      ev("p1", "brand", "Philips"),
    ]);
    const verdict = ok([bad, good, good, good, good]);
    expect(verdict.answer?.paragraphs).toHaveLength(3);
    expect(verdict.rejected).toContain("forbidden_claim");
  });

  it("rejects malformed model output without throwing", () => {
    for (const raw of [
      null,
      "x",
      [],
      {},
      { paragraphs: [] },
      { paragraphs: "x" },
      { paragraphs: [null] },
      { paragraphs: [{ text: 5 }] },
    ]) {
      expect(validateAnswer(raw, FACTS).answer).toBeNull();
    }
  });

  it("price comparison tolerates thousand separators in the quote, not in the claim itself", () => {
    const verdict = ok([
      para("Philips ürünü 1.299 TL fiyatla Hepsiburada mağazasında listelenmiş durumda.", [
        ev("p1", "price", "1.299 TL"),
        ev("p1", "store", "Hepsiburada"),
      ]),
    ]);
    expect(verdict.answer).not.toBeNull();
  });
});

describe("looksLikeResultQuestion", () => {
  it("detects questions about the shown results", () => {
    for (const text of [
      "hangisi daha uygun?",
      "bu ürünlerin farklarını açıklar mısın",
      "Bunları karşılaştır",
      "hangisini önerirsin",
      "aralarında ne fark var?",
    ]) {
      expect(looksLikeResultQuestion(text), text).toBe(true);
    }
  });
  it("stays false for searches, refinements and noise", () => {
    for (const text of [
      "",
      "ok",
      "siyah olsun",
      "masa lambası",
      "2500 TL altı",
      "x".repeat(400) + " hangisi",
    ]) {
      expect(looksLikeResultQuestion(text), text).toBe(false);
    }
  });
});

describe("toResultFacts / fallbackAnswerText", () => {
  it("caps at 8, converts kuruş to whole TL and nulls foreign prices", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      title: `Ürün ${i}`,
      brandName: i % 2 ? "Marka" : null,
      merchantName: "Mağaza",
      minPrice: 129_900,
      offerCount: 2,
      ...(i === 1 ? { foreignPrice: { currency: "USD" } } : {}),
    }));
    const facts = toResultFacts(items);
    expect(facts).toHaveLength(8);
    expect(facts[0]).toMatchObject({ id: "p1", price_try: 1299, brand: null });
    expect(facts[1]).toMatchObject({ id: "p2", price_try: null });
  });

  it("falls back to a model-free summary, or an honest sentence without data", () => {
    const text = fallbackAnswerText(FACTS, "hangisi");
    expect(text).toContain("yorumlayamadım");
    expect(text).toMatch(/TL/);
    expect(fallbackAnswerText([], "x")).toContain("güvenle karşılaştıramadım");
  });
});

describe("isChatAnswerEnabled", () => {
  const base = { CHAT_DISCOVERY_ENABLED: "true", CHAT_RESULT_ANSWER: "true" };
  it("is off by default and the flag alone opens nobody", () => {
    expect(isChatAnswerEnabled(7, {})).toBe(false);
    expect(isChatAnswerEnabled(7, base)).toBe(false);
    expect(isChatAnswerEnabled(7, { ...base, CHAT_RESULT_ANSWER_USERS: "" })).toBe(false);
  });
  it("opens only allow-listed users, or everyone with *", () => {
    expect(isChatAnswerEnabled(7, { ...base, CHAT_RESULT_ANSWER_USERS: "3, 7" })).toBe(true);
    expect(isChatAnswerEnabled(8, { ...base, CHAT_RESULT_ANSWER_USERS: "3, 7" })).toBe(false);
    expect(isChatAnswerEnabled(8, { ...base, CHAT_RESULT_ANSWER_USERS: "*" })).toBe(true);
  });
  it("needs the chat itself and the exact flag value", () => {
    expect(
      isChatAnswerEnabled(7, { CHAT_RESULT_ANSWER: "true", CHAT_RESULT_ANSWER_USERS: "7" }),
    ).toBe(false);
    expect(
      isChatAnswerEnabled(7, { ...base, CHAT_RESULT_ANSWER: "1", CHAT_RESULT_ANSWER_USERS: "7" }),
    ).toBe(false);
  });
});

describe("forbidden claims survive Turkish suffixes", () => {
  it("rejects suffixed forms such as hızlıca, dayanıklılığı, kalitesi", () => {
    for (const text of [
      "Bu set lastik patlaklarını hızlıca onarmak amacıyla tasarlanmış ve listede yer alıyor.",
      "Philips ürününün dayanıklılığı yüksek görünüyor ve Hepsiburada listesinde yer alıyor.",
      "Xiaomi ürününün kalitesi Trendyol listesinde öne çıkıyor ve markası belirtilmiş durumda.",
    ]) {
      const verdict = ok([para(text, [ev("p1", "brand", "Philips")])]);
      expect(verdict.answer, text).toBeNull();
      expect(verdict.rejected[0], text).toBe("forbidden_claim");
    }
  });
});

describe("evidence rules found by the 20-call smoke test", () => {
  const title = (text: string, quote: string) => ok([para(text, [ev("p1", "title", quote)])]);

  it("accepts honest absence statements that name a topic word", () => {
    const verdict = title(
      "Listelediğim ürünlerin başlıklarında dayanıklılık veya kalite bilgisi belirtilmemiş durumda.",
      "Philips Hue",
    );
    expect(verdict.rejected).toEqual([]);
    expect(verdict.answer).not.toBeNull();
  });

  it("still rejects a positive topic claim, and strong claims even inside an absence sentence", () => {
    expect(
      title(
        "Philips Hue çok dayanıklı bir üründür, ancak pil bilgisi belirtilmemiş durumda burada.",
        "Philips Hue",
      ).rejected,
    ).toEqual(["forbidden_claim"]);
    expect(
      title(
        "Philips Hue en iyi seçenek olmasına rağmen pil bilgisi belirtilmemiş durumda.",
        "Philips Hue",
      ).rejected,
    ).toEqual(["forbidden_claim"]);
  });

  it("accepts numbers that are part of the cited item's title, not numbers from other items", () => {
    const facts: ResultFact[] = [
      {
        id: "p1",
        title: "Xiaomi Mi Power Bank 3 10000mAh",
        brand: null,
        store: null,
        price_try: 849,
        offer_count: 4,
      },
      {
        id: "p2",
        title: "Anker 313 Power Bank",
        brand: null,
        store: null,
        price_try: 1099,
        offer_count: 2,
      },
    ];
    const good = validateAnswer(
      {
        paragraphs: [
          {
            text: "Xiaomi Mi Power Bank 3 modeli 10000mAh kapasiteli ve 849 TL fiyatla listeleniyor.",
            evidence: [
              { item: "p1", field: "title", quote: "Power Bank 3" },
              { item: "p1", field: "price", quote: "849" },
            ],
          },
        ],
      },
      facts,
    );
    expect(good.rejected).toEqual([]);
    const wrongItem = validateAnswer(
      {
        paragraphs: [
          {
            text: "Xiaomi modeli 313 numaralı seri olarak 849 TL fiyatla listeleniyor burada.",
            evidence: [
              { item: "p1", field: "title", quote: "Power Bank 3" },
              { item: "p1", field: "price", quote: "849" },
            ],
          },
        ],
      },
      facts,
    );
    expect(wrongItem.rejected).toEqual(["unevidenced_number"]);
  });

  it("a money amount needs a price quote: a number found only in a title is not a price", () => {
    const facts: ResultFact[] = [
      {
        id: "p1",
        title: "Power Bank 5000mAh",
        brand: null,
        store: null,
        price_try: 624,
        offer_count: 1,
      },
    ];
    const verdict = validateAnswer(
      {
        paragraphs: [
          {
            text: "Power Bank 5000 TL fiyatla listeleniyor ve başlığında kapasite yer alıyor burada.",
            evidence: [{ item: "p1", field: "title", quote: "Power Bank 5000mAh" }],
          },
        ],
      },
      facts,
    );
    expect(verdict.rejected).toEqual(["unevidenced_number"]);
  });

  it("allows the user's own number to be echoed", () => {
    const text = "1000 TL bütçenizin altında Philips Hue ürünü 624 TL fiyatla listeleniyor burada.";
    const evidence = [ev("p1", "price", "624")];
    const facts: ResultFact[] = [
      {
        id: "p1",
        title: "Philips Hue",
        brand: "Philips",
        store: null,
        price_try: 624,
        offer_count: 1,
      },
    ];
    expect(validateAnswer({ paragraphs: [para(text, evidence)] }, facts).answer).toBeNull();
    expect(
      validateAnswer({ paragraphs: [para(text, evidence)] }, facts, {
        question: "Bütçem 1000 TL, hangisini önerirsin?",
      }).rejected,
    ).toEqual([]);
  });
});

describe("absence phrases with Turkish suffixes, store names with digits", () => {
  it("accepts yer almamaktadır / belirtilmemiştir / bulunmamaktadır as honest absence", () => {
    for (const text of [
      "Listelenen kılıfların başlıklarında dayanıklılık bilgisi yer almamaktadır, kenar korumasına dair veri yok.",
      "Başlıklarda belirli bir telefon ile uyumluluk bilgisi belirtilmemiştir ve teknik detay verilmemiştir.",
      "Çelik kalitesine dair teknik bir veri bulunmamaktadır, bu yüzden kıyaslama yapılamıyor burada.",
    ]) {
      const verdict = ok([para(text, [ev("p1", "title", "Philips Hue")])]);
      expect(verdict.rejected, text).toEqual([]);
    }
  });

  it("accepts a digit inside a cited store name (n11)", () => {
    const facts: ResultFact[] = [
      {
        id: "p1",
        title: "Anker Power Bank",
        brand: "Anker",
        store: "n11",
        price_try: 1099,
        offer_count: 2,
      },
    ];
    const verdict = validateAnswer(
      {
        paragraphs: [
          {
            text: "Anker Power Bank, n11 mağazasında 1099 TL fiyatla listeleniyor ve markası Anker olarak geçiyor.",
            evidence: [
              { item: "p1", field: "store", quote: "n11" },
              { item: "p1", field: "price", quote: "1099" },
            ],
          },
        ],
      },
      facts,
    );
    expect(verdict.rejected).toEqual([]);
  });
});

describe("internal ids and soft characterizations (full-pilot prerequisites)", () => {
  it("rejects internal item ids shown to the user", () => {
    const verdict = ok([
      para(
        "Listelenen ürünlerden p5 numaralı Philips kılıf başlıkta iPhone 15 ifadesini taşıyor.",
        [ev("p1", "brand", "Philips")],
      ),
    ]);
    expect(verdict.rejected).toEqual(["internal_id"]);
  });

  it("rejects unevidenced purpose/audience/advancement characterizations", () => {
    for (const text of [
      "Xiaomi daha fazla teknolojik imkan sunan bir seçenek olarak listelenmiş durumda burada.",
      "Philips Hue günlük kullanıma yönelik tasarımlardan biri olarak listede yer alıyor.",
      "Philips Hue genel kullanım amaçlı tasarlanmış bir ürün olarak listelenmiş durumda burada.",
      "Philips Hue bu liste içindeki en gelişmiş ve ideal seçenek olarak görünüyor burada.",
    ]) {
      const verdict = ok([para(text, [ev("p1", "brand", "Philips")])]);
      expect(verdict.answer, text).toBeNull();
      expect(verdict.rejected[0], text).toBe("forbidden_claim");
    }
  });

  it("still allows saying such information is absent", () => {
    const verdict = ok([
      para("Başlıklarda ürünlerin hangi kullanıma yönelik tasarlandığı belirtilmemiş durumda.", [
        ev("p1", "brand", "Philips"),
      ]),
    ]);
    expect(verdict.rejected).toEqual([]);
  });
});
