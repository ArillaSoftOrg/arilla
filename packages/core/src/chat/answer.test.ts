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
      "Bu fiyatlar bugünün fiyatı mı?",
      "Fiyatlara göre sıralayıp hangi mağazada olduğunu söyler misin?",
      "Kargo dahil mi bunlar?",
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
  it("caps at 8, converts kuruş to whole TL; foreign prices become approximate TL with a date only when known", () => {
    const items = Array.from({ length: 12 }, (_, i) => ({
      title: `Ürün ${i}`,
      brandName: i % 2 ? "Marka" : null,
      merchantName: "Mağaza",
      minPrice: 129_900,
      offerCount: 2,
      ...(i === 1 ? { foreignPrice: { fxDate: "2026-11-13" } } : {}),
      ...(i === 2 ? { foreignPrice: { fxDate: null } } : {}),
      ...(i === 3 ? { minPrice: null as number | null } : {}),
    }));
    const facts = toResultFacts(items);
    expect(facts).toHaveLength(8);
    expect(facts[0]).toMatchObject({ id: "p1", price_try: 1299, brand: null });
    expect(facts[0]).not.toHaveProperty("price_approx");
    expect(facts[0]).not.toHaveProperty("price_date");
    expect(facts[1]).toMatchObject({
      id: "p2",
      price_try: 1299,
      price_approx: true,
      price_date: "2026-11-13",
    });
    // tarih bilinmiyorsa alan hiç eklenmez (uydurma tarih yok)
    expect(facts[2]).toMatchObject({ price_try: 1299, price_approx: true });
    expect(facts[2]).not.toHaveProperty("price_date");
    // fiyatı olmayan ürün çıkarılmaz; fiyat null kalır
    expect(facts[3]).toMatchObject({ id: "p4", price_try: null });
    expect(facts).toHaveLength(8);
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

describe("full-pilot findings: more soft characterizations, more absence verbs", () => {
  it("rejects capability-set / practicality wording; accepts 'verilmemiş' as absence", () => {
    for (const text of [
      "Apple Watch SE 9499 TL fiyatıyla daha kapsamlı özellikler sunan bir model olarak listelenmiş.",
      "Xiaomi saatleri geniş özellik setleri ve farklı mağaza teklifleriyle listede yer alıyor burada.",
      "Günlük kombinlerde pratik bir tercih olan elbise Trendyol listesinde yer alıyor burada.",
    ]) {
      const verdict = ok([para(text, [ev("p1", "brand", "Philips")])]);
      expect(verdict.rejected[0], text).toBe("forbidden_claim");
    }
    const absent = ok([
      para(
        "Ürünlerin başlıklarında düşmeye karşı dayanıklılık bilgisi verilmemiş durumda burada.",
        [ev("p1", "brand", "Philips")],
      ),
    ]);
    expect(absent.rejected).toEqual([]);
  });
});

describe("approximate prices (decision 0213)", () => {
  const approxFacts: ResultFact[] = [
    {
      id: "p1",
      title: "Mini Magnetic Power Bank 10000mAh",
      brand: null,
      store: "AliExpress",
      price_try: 312,
      offer_count: 1,
      price_approx: true,
      price_date: "2026-11-13",
    },
    {
      id: "p2",
      title: "Anker 313 Power Bank",
      brand: "Anker",
      store: "n11",
      price_try: 1099,
      offer_count: 2,
    },
  ];
  const run = (text: string) =>
    validateAnswer(
      {
        paragraphs: [
          {
            text,
            evidence: [
              { item: "p1", field: "price", quote: "312" },
              { item: "p1", field: "title", quote: "Power Bank" },
            ],
          },
        ],
      },
      approxFacts,
    );

  it("an approximate price must be labelled approximate", () => {
    expect(
      run("Mini Magnetic Power Bank AliExpress'te 312 TL fiyatla listeleniyor burada.").rejected,
    ).toEqual(["approx_price_unlabelled"]);
    expect(
      run("Mini Magnetic Power Bank AliExpress'te yaklaşık 312 TL fiyatla listeleniyor.").rejected,
    ).toEqual([]);
    expect(
      run("Mini Magnetic Power Bank AliExpress'te 312 TL civarında bir fiyatla listeleniyor.")
        .rejected,
    ).toEqual([]);
  });

  it("an exact TRY price needs no label", () => {
    const verdict = validateAnswer(
      {
        paragraphs: [
          {
            text: "Anker 313 Power Bank n11'de 1099 TL fiyatla listeleniyor burada.",
            evidence: [
              { item: "p2", field: "price", quote: "1099" },
              { item: "p2", field: "store", quote: "n11" },
            ],
          },
        ],
      },
      approxFacts,
    );
    expect(verdict.rejected).toEqual([]);
  });

  it("the price date can be stated only when the fact carries it", () => {
    expect(
      run("Mini Magnetic Power Bank yaklaşık 312 TL, fiyat 2026-11-13 kuruyla hesaplanmış durumda.")
        .rejected,
    ).toEqual([]);
    expect(
      run("Mini Magnetic Power Bank yaklaşık 312 TL, fiyat 2026-10-02 tarihli olarak listeleniyor.")
        .rejected,
    ).toEqual(["unevidenced_number"]);
  });

  it("never assumes shipping, tax or total cost; saying the data is absent is fine", () => {
    for (const text of [
      "Mini Magnetic Power Bank yaklaşık 312 TL ve kargo dahil bir fiyatla listeleniyor burada.",
      "Mini Magnetic Power Bank yaklaşık 312 TL; vergiler eklenince toplam maliyet artar diye düşünülebilir.",
      "Mini Magnetic Power Bank yaklaşık 312 TL ve kargosu ücretsiz olarak listelenmiş görünüyor.",
    ]) {
      expect(run(text).rejected[0], text).toBe("forbidden_claim");
    }
    expect(
      run("Mini Magnetic Power Bank yaklaşık 312 TL; kargo ve vergi bilgisi belirtilmemiş durumda.")
        .rejected,
    ).toEqual([]);
  });

  it("fallback summary says foreign prices are approximate", () => {
    const text = fallbackAnswerText(
      [
        ...approxFacts,
        {
          id: "p3",
          title: "Üçüncü ürün",
          brand: null,
          store: "Trendyol",
          price_try: 500,
          offer_count: 1,
        },
      ],
      "x",
    );
    expect(text).toContain("yaklaşık TL");
  });
});

describe("false absence claims (decision 0213)", () => {
  const facts: ResultFact[] = [
    {
      id: "p1",
      title: "Woman Ballet Dance Shorts Cotton High Waist",
      brand: null,
      store: null,
      price_try: 200,
      offer_count: 1,
    },
    {
      id: "p2",
      title: "Case for iPhone 11 12 13 14 15 16 17 Pro Max",
      brand: null,
      store: null,
      price_try: 100,
      offer_count: 1,
    },
    {
      id: "p3",
      title: "Xiaomi Redmi Buds 5 LP40 Pro",
      brand: null,
      store: null,
      price_try: 300,
      offer_count: 1,
    },
  ];
  const run = (text: string) =>
    validateAnswer(
      { paragraphs: [{ text, evidence: [{ item: "p1", field: "title", quote: "Cotton" }] }] },
      facts,
    );

  it("rejects 'none of the titles mentions X' when a title does", () => {
    expect(
      run("Hiçbir ürünün başlığında pamuklu kumaş bilgisi yer almamaktadır, kalıp da yok.")
        .rejected,
    ).toEqual(["false_absence"]);
    expect(
      run("Listelenen ürünlerin başlıklarında iPhone 16 ile uyumluluk bilgisi bulunmuyor burada.")
        .rejected,
    ).toEqual(["false_absence"]);
  });

  it("accepts a scoped absence, a true absence and product names that merely contain digits", () => {
    expect(
      run("Diğer ürünlerin başlığında pamuklu kumaş bilgisi yer almamaktadır burada.").rejected,
    ).toEqual([]);
    expect(
      run("Hiçbir ürünün başlığında deri malzeme bilgisi yer almamaktadır, yalnızca fiyat var.")
        .rejected,
    ).toEqual([]);
    expect(
      validateAnswer(
        {
          paragraphs: [
            {
              text: "Redmi Buds 5 ve LP40 Pro ürünlerinin başlıklarında pil süresi bilgisi bulunmamaktadır.",
              evidence: [{ item: "p3", field: "title", quote: "Redmi Buds" }],
            },
          ],
        },
        facts,
      ).rejected,
    ).toEqual([]);
  });
});

describe("superlative prices must match the facts (decision 0213)", () => {
  const priced: ResultFact[] = [
    {
      id: "p1",
      title: "Tefal Çelik Termos 1 L",
      brand: null,
      store: "Hepsiburada",
      price_try: 1099,
      offer_count: 1,
    },
    {
      id: "p2",
      title: "CLS Outdoor Bardak Seti",
      brand: null,
      store: "AliExpress",
      price_try: 149,
      offer_count: 1,
      price_approx: true,
      price_date: "2026-11-13",
    },
    {
      id: "p3",
      title: "Stanley Klasik Termos",
      brand: null,
      store: "Termos Dünyası",
      price_try: 2899,
      offer_count: 1,
    },
  ];
  const run = (text: string, item = "p1", field: "price" = "price", quote = "1099") =>
    validateAnswer({ paragraphs: [{ text, evidence: [{ item, field, quote }] }] }, priced);

  it("rejects calling a product the cheapest when a lower approximate price exists", () => {
    expect(
      run("Tefal Çelik Termos, 1099 TL fiyatıyla en uygun fiyatlı seçenektir burada.").rejected,
    ).toEqual(["wrong_superlative"]);
  });

  it("accepts the true cheapest and the true most expensive, scoped claims and sentences without prices", () => {
    expect(
      run(
        "En uygun fiyatlı seçenek yaklaşık 149 TL ile CLS Outdoor Bardak Seti'dir.",
        "p2",
        "price",
        "149",
      ).rejected,
    ).toEqual([]);
    expect(
      run(
        "En yüksek fiyat 2899 TL ile Stanley Klasik Termos'a ait görünüyor burada.",
        "p3",
        "price",
        "2899",
      ).rejected,
    ).toEqual([]);
    // mağaza kapsamlı iddia: yalnız o mağazadaki ürünler arasında
    expect(
      run("Hepsiburada mağazasında en düşük fiyat 1099 TL ile Tefal Çelik Termos'tur burada.")
        .rejected,
    ).toEqual([]);
  });
});

describe("freshness claims and capitalised framing (decision 0213)", () => {
  const f: ResultFact[] = [
    {
      id: "p1",
      title: "Philips Hue",
      brand: "Philips",
      store: "Trendyol",
      price_try: 100,
      offer_count: 1,
    },
  ];
  const run = (text: string) =>
    validateAnswer(
      { paragraphs: [{ text, evidence: [{ item: "p1", field: "brand", quote: "Philips" }] }] },
      f,
    );

  it("rejects 'güncel' price claims and need-assuming framing in any capitalisation", () => {
    for (const text of [
      "Philips ürününün Trendyol'daki fiyatı günceldir ve listede yer alıyor burada.",
      "İhtiyacınız varsa Philips ürünü Trendyol listesinde yer alıyor burada.",
      "Kontrolcünüzü şarj etmek istiyorsanız Philips ürünü Trendyol listesinde yer alıyor.",
    ]) {
      expect(run(text).rejected[0], text).toBe("forbidden_claim");
    }
  });

  it("accepts an honest 'we do not know if it is current'", () => {
    expect(
      run(
        "Fiyatların güncel olup olmadığını bilmiyorum; Philips ürünü Trendyol listesinde yer alıyor.",
      ).rejected,
    ).toEqual([]);
  });
});
