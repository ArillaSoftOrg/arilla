/**
 * Elle secilmis netlestirme kurallari (docs/decisions/0030). Kod degil veri:
 * yeni bir urun ailesi eklemek bu listeye bir nesne eklemektir; motor
 * degismez. Dunyadaki her kategoriyi modellemek amac degil - yalnizca
 * belirsiz sorgularin sik geldigi aileler burada durur. Eslesmeyen sorgu
 * soru sorulmadan dogrudan aranir.
 *
 * `categoryPath` degerleri mevcut kategori agacindandir
 * (packages/db/migrations/0016_category_expansion.sql). Katalogda olmayan bir
 * yol derlemede dusurulur (`compileQuery`), hic sonuc donmeyen bir filtreye
 * donusmez.
 *
 * Butce bantlari TL cinsinden, elle secilmis arayuz basamaklaridir; fiyat
 * iddiasi degildir. Katalog fiyat dagilimi (product_price_stats) olgunlasinca
 * oradan turetilmelidir.
 */
import type { ClarificationRegistry, DomainDefinition } from "./types.ts";

const HELMET: DomainDefinition = {
  id: "helmet",
  kind: "product",
  triggers: ["kask*"],
  // Motosiklet kaskina ozgu sorular bisiklet/is guvenligi kaskina uymaz;
  // bu sorgular soru sorulmadan aranir.
  blockers: [
    "vizör*",
    "kilit*",
    "interkom*",
    "kask çanta*",
    "bisiklet*",
    "baret*",
    "iş güvenliğ*",
    "kaykay*",
    "paten*",
    "binicilik*",
  ],
  retrievalTerms: ["kask"],
  facets: [
    {
      id: "helmet_type",
      question: "Nasıl bir kask arıyorsun?",
      role: "filter",
      skipLabel: "Emin değilim",
      options: [
        {
          id: "full_face",
          label: "Kapalı (full face)",
          triggers: ["kapalı", "full face", "fullface", "full-face"],
          contribution: { terms: ["kapalı"] },
        },
        {
          id: "open_face",
          label: "Açık (jet)",
          triggers: ["açık", "jet", "open face", "open-face"],
          contribution: { terms: ["jet"] },
        },
        {
          id: "half",
          label: "Yarım",
          triggers: ["yarım", "half", "yarım kafa"],
          contribution: { terms: ["yarım"] },
        },
        {
          id: "modular",
          label: "Modüler (çene açılır)",
          triggers: ["modüler", "çene açılır", "flip up", "flip-up"],
          contribution: { terms: ["çene açılır"] },
        },
        {
          id: "off_road",
          label: "Arazi (off-road)",
          triggers: ["off-road", "off road", "offroad", "kros", "cross", "motokros"],
          contribution: { terms: ["cross"] },
          implies: { use_case: "off_road" },
        },
      ],
    },
    {
      id: "use_case",
      question: "Kaskı en çok nerede kullanacaksın?",
      role: "planning",
      skipLabel: "Fark etmez",
      options: [
        { id: "city", label: "Şehir içi", triggers: ["şehir içi", "şehir*"] },
        { id: "touring", label: "Uzun yol", triggers: ["uzun yol", "tur", "turing", "touring"] },
        { id: "scooter", label: "Scooter", triggers: ["scooter*", "skuter*"] },
        { id: "track", label: "Pist", triggers: ["pist*"] },
        { id: "off_road", label: "Arazi", triggers: ["arazi*"] },
      ],
    },
  ],
  questionOrder: [
    { facetId: "helmet_type", importance: "essential" },
    { facetId: "use_case", importance: "useful" },
    { facetId: "budget", importance: "useful" },
  ],
  budgetQuestion: "Kask için ne kadar ayırmayı düşünüyorsun?",
  budgetBands: [
    { id: "up_to_2500", label: "2.500 TL'ye kadar", minTry: null, maxTry: 2500 },
    { id: "2500_5000", label: "2.500 – 5.000 TL", minTry: 2500, maxTry: 5000 },
    { id: "5000_10000", label: "5.000 – 10.000 TL", minTry: 5000, maxTry: 10000 },
    { id: "over_10000", label: "10.000 TL ve üzeri", minTry: 10000, maxTry: null },
  ],
  readyAfterSignals: 2,
  maxQuestions: 2,
};

const SHOES: DomainDefinition = {
  id: "shoes",
  kind: "product",
  triggers: ["ayakkabı*", "ayakkabi*"],
  blockers: ["bağcık*", "boya*", "dolab*", "dolap*", "tabanlık*", "çorap*", "kutusu"],
  retrievalTerms: ["ayakkabı"],
  facets: [
    {
      id: "shoe_type",
      question: "Nasıl bir ayakkabı arıyorsun?",
      role: "filter",
      skipLabel: "Fark etmez",
      options: [
        {
          id: "sneaker",
          label: "Spor / sneaker",
          triggers: ["spor", "sneaker*", "günlük"],
          contribution: { terms: ["sneaker"] },
        },
        {
          id: "running",
          label: "Koşu",
          triggers: ["koşu", "koşu ayakkabı*", "running"],
          contribution: { terms: ["koşu"] },
        },
        {
          id: "classic",
          label: "Klasik",
          triggers: ["klasik", "loafer*", "oxford", "rugan"],
          contribution: { terms: ["klasik"] },
        },
        {
          id: "boot",
          label: "Bot",
          triggers: ["bot*", "çizme*"],
          contribution: { terms: ["bot"] },
        },
        {
          id: "sandal",
          label: "Sandalet / terlik",
          triggers: ["sandalet*", "terlik*"],
          contribution: { terms: ["sandalet"] },
        },
      ],
    },
    {
      id: "audience",
      question: "Kimin için?",
      role: "filter",
      skipLabel: "Fark etmez",
      options: [
        {
          id: "women",
          label: "Kadın",
          triggers: ["kadın*", "bayan*"],
          contribution: { terms: ["kadın"] },
        },
        {
          id: "men",
          label: "Erkek",
          triggers: ["erkek*", "bay"],
          contribution: { terms: ["erkek"] },
        },
        {
          id: "kids",
          label: "Çocuk",
          triggers: ["çocuk*", "çocuğ*"],
          contribution: { terms: ["çocuk"] },
        },
      ],
    },
  ],
  questionOrder: [
    { facetId: "shoe_type", importance: "essential" },
    { facetId: "audience", importance: "useful" },
  ],
  readyAfterSignals: 2,
  maxQuestions: 2,
};

const GIFT: DomainDefinition = {
  id: "gift",
  kind: "intent",
  triggers: ["hediye*"],
  fillerTerms: ["doğum günü*", "doğumgünü*", "yılbaşı*", "sürpriz*", "hediyelik"],
  retrievalTerms: [],
  facets: [
    {
      id: "recipient",
      question: "Hediye kimin için?",
      role: "planning",
      skipLabel: "Söylemek istemiyorum",
      options: [
        { id: "mother", label: "Annem", triggers: ["anne*", "annecim*"] },
        { id: "father", label: "Babam", triggers: ["baba*"] },
        {
          id: "partner",
          label: "Sevgilim / eşim",
          triggers: [
            "sevgili*",
            "kız arkadaş*",
            "erkek arkadaş*",
            "eşim*",
            "eşime",
            "karım*",
            "kocam*",
          ],
        },
        { id: "friend", label: "Arkadaşım", triggers: ["arkadaş*"] },
        {
          id: "child",
          label: "Çocuk",
          triggers: ["çocuk*", "çocuğ*", "oğl*", "kızım*", "yeğen*", "bebek*", "bebeğ*"],
        },
        {
          id: "sibling",
          label: "Kardeşim",
          triggers: ["kardeş*", "abi*", "abla*", "ağabey*"],
        },
        {
          id: "elder",
          label: "Büyüğüm",
          triggers: ["anneanne*", "babaanne*", "dede*", "nine*", "büyükanne*", "büyükbaba*"],
        },
        { id: "colleague", label: "İş arkadaşım", triggers: ["iş arkadaş*", "patron*", "müdür*"] },
      ],
    },
    {
      id: "age_band",
      question: "Kaç yaşında?",
      role: "planning",
      skipLabel: "Emin değilim",
      appliesWhen: { facetId: "recipient", optionIds: ["child"] },
      options: [
        {
          id: "baby",
          label: "0–2 yaş",
          triggers: ["bebek*", "bebeğ*"],
          ageRange: [0, 2],
          contribution: { categoryPath: "anne-bebek" },
        },
        { id: "kid", label: "3–7 yaş", triggers: [], ageRange: [3, 7] },
        { id: "preteen", label: "8–12 yaş", triggers: [], ageRange: [8, 12] },
        { id: "teen", label: "13–17 yaş", triggers: ["genç*"], ageRange: [13, 17] },
      ],
    },
    {
      id: "interest",
      question: "Nelerden hoşlanır?",
      role: "filter",
      skipLabel: "Emin değilim",
      options: [
        {
          id: "technology",
          label: "Teknoloji",
          triggers: ["teknoloji*", "elektronik*", "oyun*", "bilgisayar*", "gadget*"],
          contribution: { categoryPath: "elektronik" },
        },
        {
          id: "beauty",
          label: "Bakım ve kozmetik",
          triggers: ["makyaj*", "kozmetik*", "bakım*", "parfüm*", "cilt*"],
          contribution: { categoryPath: "saglik-kozmetik" },
        },
        {
          id: "home",
          label: "Ev ve mutfak",
          triggers: ["mutfak*", "yemek*", "dekorasyon*", "ev dekor*", "ev işler*"],
          contribution: { categoryPath: "ev-yasam" },
        },
        {
          id: "sports",
          label: "Spor ve doğa",
          triggers: ["spor*", "koşu*", "kamp*", "doğa*", "outdoor", "fitness"],
          contribution: { categoryPath: "spor-outdoor" },
        },
        {
          id: "hobby",
          label: "Kitap ve hobi",
          triggers: ["kitap*", "müzik*", "hobi*", "okuma*", "resim*"],
          contribution: { categoryPath: "kitap-muzik-hobi" },
        },
        {
          id: "fashion",
          label: "Moda ve aksesuar",
          triggers: ["moda*", "giyim*", "kıyafet*", "aksesuar*", "takı*"],
          contribution: { categoryPath: "moda" },
        },
      ],
    },
  ],
  questionOrder: [
    { facetId: "recipient", importance: "essential" },
    { facetId: "age_band", importance: "essential" },
    { facetId: "interest", importance: "useful" },
    { facetId: "budget", importance: "useful" },
  ],
  budgetQuestion: "Ne kadar harcamayı düşünüyorsun?",
  budgetBands: [
    { id: "up_to_500", label: "500 TL'ye kadar", minTry: null, maxTry: 500 },
    { id: "500_1000", label: "500 – 1.000 TL", minTry: 500, maxTry: 1000 },
    { id: "1000_2500", label: "1.000 – 2.500 TL", minTry: 1000, maxTry: 2500 },
    { id: "over_2500", label: "2.500 TL ve üzeri", minTry: 2500, maxTry: null },
  ],
  readyAfterSignals: 2,
  maxQuestions: 3,
  readyOnConcreteTerms: true,
};

const PHONE: DomainDefinition = {
  id: "phone",
  kind: "product",
  triggers: ["telefon*", "cep telefon*", "akıllı telefon*"],
  blockers: [
    "kılıf*",
    "şarj*",
    "kablo*",
    "ekran koruyucu*",
    "tutucu*",
    "kulaklı*",
    "tripod*",
    "stand*",
  ],
  retrievalTerms: ["telefon"],
  categoryPath: "elektronik",
  facets: [
    {
      id: "platform",
      question: "Hangi işletim sistemini tercih edersin?",
      role: "filter",
      skipLabel: "Fark etmez",
      options: [
        {
          id: "ios",
          label: "iPhone (iOS)",
          triggers: ["iphone*", "ios", "apple"],
          contribution: { terms: ["iphone"] },
        },
        {
          id: "android",
          label: "Android",
          triggers: ["android*"],
          contribution: { terms: ["android"] },
        },
      ],
    },
  ],
  questionOrder: [
    { facetId: "budget", importance: "essential" },
    { facetId: "platform", importance: "useful" },
  ],
  budgetQuestion: "Telefon için ne kadar ayırmayı düşünüyorsun?",
  budgetBands: [
    { id: "up_to_10000", label: "10.000 TL'ye kadar", minTry: null, maxTry: 10000 },
    { id: "10000_20000", label: "10.000 – 20.000 TL", minTry: 10000, maxTry: 20000 },
    { id: "20000_40000", label: "20.000 – 40.000 TL", minTry: 20000, maxTry: 40000 },
    { id: "over_40000", label: "40.000 TL ve üzeri", minTry: 40000, maxTry: null },
  ],
  readyAfterSignals: 2,
  maxQuestions: 2,
};

const ELECTRONICS: DomainDefinition = {
  id: "electronics",
  kind: "product",
  triggers: ["elektronik*", "teknolojik ürün*", "teknoloji ürün*"],
  retrievalTerms: [],
  categoryPath: "elektronik",
  facets: [
    {
      id: "electronics_type",
      question: "Ne tür bir ürün arıyorsun?",
      role: "filter",
      skipLabel: "Fark etmez",
      options: [
        {
          id: "headphones",
          label: "Kulaklık",
          triggers: ["kulaklık*"],
          contribution: { terms: ["kulaklık"] },
        },
        {
          id: "smartwatch",
          label: "Akıllı saat",
          triggers: ["akıllı saat*", "saat*"],
          contribution: { terms: ["akıllı saat"] },
        },
        {
          id: "power",
          label: "Şarj ve powerbank",
          triggers: ["şarj*", "powerbank*", "power bank*"],
          contribution: { terms: ["şarj"] },
        },
        {
          id: "speaker",
          label: "Hoparlör",
          triggers: ["hoparlör*", "speaker*"],
          contribution: { terms: ["hoparlör"] },
        },
        {
          id: "peripherals",
          label: "Klavye ve mouse",
          triggers: ["klavye*", "mouse*", "fare"],
          contribution: { terms: ["klavye"] },
        },
      ],
    },
  ],
  questionOrder: [
    { facetId: "electronics_type", importance: "essential" },
    { facetId: "budget", importance: "useful" },
  ],
  budgetQuestion: "Ne kadar ayırmayı düşünüyorsun?",
  budgetBands: [
    { id: "up_to_1000", label: "1.000 TL'ye kadar", minTry: null, maxTry: 1000 },
    { id: "1000_3000", label: "1.000 – 3.000 TL", minTry: 1000, maxTry: 3000 },
    { id: "3000_7500", label: "3.000 – 7.500 TL", minTry: 3000, maxTry: 7500 },
    { id: "over_7500", label: "7.500 TL ve üzeri", minTry: 7500, maxTry: null },
  ],
  readyAfterSignals: 1,
  maxQuestions: 2,
  readyOnConcreteTerms: true,
};

const HOME: DomainDefinition = {
  id: "home",
  kind: "product",
  triggers: ["evim*", "ev için", "eve", "ev eşya*", "ev dekor*", "mobilya*"],
  retrievalTerms: [],
  categoryPath: "ev-yasam",
  facets: [
    {
      id: "home_type",
      question: "Evin için ne tür bir şey bakıyorsun?",
      role: "filter",
      skipLabel: "Fark etmez",
      options: [
        {
          id: "furniture",
          label: "Mobilya",
          triggers: ["koltuk*", "masa*", "sandalye*", "dolap*", "raf*"],
          contribution: { terms: ["mobilya"] },
        },
        {
          id: "lighting",
          label: "Aydınlatma",
          triggers: ["lamba*", "aydınlatma*", "avize*", "abajur*"],
          contribution: { terms: ["lamba"] },
        },
        {
          id: "textile",
          label: "Ev tekstili",
          triggers: ["nevresim*", "battaniye*", "halı*", "perde*", "yastık*", "tekstil*"],
          contribution: { terms: ["battaniye"] },
        },
        {
          id: "decor",
          label: "Dekorasyon",
          triggers: ["dekorasyon*", "dekor*", "vazo*", "çerçeve*", "mum*"],
          contribution: { terms: ["dekorasyon"] },
        },
        {
          id: "kitchen",
          label: "Mutfak",
          triggers: ["mutfak*", "tencere*", "tabak*", "bardak*"],
          contribution: { terms: ["mutfak"] },
        },
      ],
    },
  ],
  questionOrder: [{ facetId: "home_type", importance: "essential" }],
  readyAfterSignals: 1,
  maxQuestions: 1,
  readyOnConcreteTerms: true,
};

export const DEFAULT_CLARIFICATION_REGISTRY: ClarificationRegistry = {
  domains: [HELMET, SHOES, GIFT, PHONE, ELECTRONICS, HOME],
};
