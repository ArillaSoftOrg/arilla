/**
 * Konusmali netlestirme katmani (docs/decisions/0030). Erisimden ONCE calisir:
 * kullanicinin anlattigini yapilandirilmis bir duruma cevirir, yeterince bilgi
 * birikince mevcut arama motoruna (`search()`) giden `QueryObject`'i uretir.
 *
 * Bu katman urun, fiyat, stok veya marka URETMEZ. Tek isi niyeti anlamak ve
 * gerekiyorsa tek bir soru sormaktir. Urun gercegi her zaman katalogdan gelir.
 */

// ---------------------------------------------------------------------------
// Kural sozlugu (taksonomi). Secenek degerleri yalnizca buradan gelir.
// ---------------------------------------------------------------------------

/**
 * Bir secenegin aramaya katkisi. Yalnizca mevcut aramanin anladigi iki kanal
 * var: metin kapisi (`unparsed` token'lari) ve `category_path` filtresi.
 * Karsiligi olmayan bir alan buraya eklenmez (docs/search.md: "Karsiligi
 * olmayan alan nesneye eklenmez").
 */
export interface SearchContribution {
  /** Metin kapisina eklenecek niteleyiciler. Bas isim domain'den gelir. */
  terms?: readonly string[];
  /** Mevcut bir `category.path`. Bilinmeyen yol derleme sirasinda dusurulur. */
  categoryPath?: string;
}

export interface ClarificationOptionDefinition {
  /** Kararli, URL'de tasinan kimlik: `full_face`. */
  id: string;
  /** Kullaniciya gorunen Turkce etiket. ALL CAPS yok, yasakli kelime yok. */
  label: string;
  /**
   * Serbest metinde bu secenegi taniyan yuzeyler. Sondaki `*` Turkce ekleri
   * kabul eder (`anne*` -> anneme, annemin). Yildizsiz yuzey tam kelimedir.
   */
  triggers: readonly string[];
  contribution?: SearchContribution;
  /** Bu secim baska bir faseti ima ediyorsa (`off_road` kask -> arazi kullanimi). */
  implies?: Readonly<Record<string, string>>;
  /** Yas bandi secenekleri icin: "10 yasindaki" -> bu araliga duser. */
  ageRange?: readonly [number, number];
}

export type FacetRole =
  /** Secim aramaya dogrudan katki yapar; her secenegin katkisi olmak zorunda. */
  | "filter"
  /**
   * Secim aramaya dogrudan girmez ama sonraki soruyu belirler (hediye
   * alicisi -> cocuksa yas bandi sorulur). Bilincli ve belgelenmis istisna.
   */
  | "planning";

export interface FacetDefinition {
  id: string;
  /** Soru metni: "Nasıl bir kask arıyorsun?" */
  question: string;
  role: FacetRole;
  /** Atlama seceneginin etiketi: "Emin değilim" / "Fark etmez". */
  skipLabel: string;
  options: readonly ClarificationOptionDefinition[];
  /** Yalnizca baska bir faset belirli degerlerdeyse sorulur. */
  appliesWhen?: { facetId: string; optionIds: readonly string[] };
}

/** Butce bantlari kuruş degil TL tutar; derlemede kurusa cevrilir. */
export interface BudgetBand {
  id: string;
  label: string;
  minTry: number | null;
  maxTry: number | null;
}

export type QuestionImportance =
  /** Cevaplanmadan (ya da atlanmadan) arama hazir sayilmaz. */
  | "essential"
  /** Yalnizca sinyal sayisi hala dusukse ve soru butcesi varsa sorulur. */
  | "useful";

export const BUDGET_FACET_ID = "budget";

export interface DomainDefinition {
  id: string;
  /** `product`: belirli bir urun ailesi. `intent`: hediye gibi urun-ustu niyet. */
  kind: "product" | "intent";
  /** Domain'i taniyan yuzeyler (`kask*`). */
  triggers: readonly string[];
  /**
   * Bu yuzeylerden biri varsa domain eslesmez: "telefon kılıfı" bir telefon
   * aramasi degildir. Turkce tamlamada bas isim sondadir.
   */
  blockers?: readonly string[];
  /** Tuketilen ama aramaya girmeyen dolgu ifadeleri ("doğum günü"). */
  fillerTerms?: readonly string[];
  /** Metin kapisinin bas ismi. Hediye gibi niyetlerde bos. */
  retrievalTerms: readonly string[];
  /** Domain'in tamaminin dustugu mevcut kategori yolu, varsa. */
  categoryPath?: string;
  facets: readonly FacetDefinition[];
  /** Soru sirasi. `budget` ozel kimliktir, `budgetBands`'ten beslenir. */
  questionOrder: readonly { facetId: string; importance: QuestionImportance }[];
  budgetQuestion?: string;
  budgetBands?: readonly BudgetBand[];
  /** Bu kadar arama sinyali birikince `useful` sorular sorulmaz. */
  readyAfterSignals: number;
  /** Bu domain'de sorulabilecek en fazla farkli soru. */
  maxQuestions: number;
  /**
   * Kullanici somut bir urun adi soylediyse ("anneme hediye çanta") baska
   * soru sormadan aranir. Niyet domain'leri icin anlamli.
   */
  readyOnConcreteTerms?: boolean;
}

export interface ClarificationRegistry {
  domains: readonly DomainDefinition[];
}

// ---------------------------------------------------------------------------
// Durum. Her tur sifirdan yorumlanmaz; bu nesne birikir.
// ---------------------------------------------------------------------------

/**
 * Oncelik: son acik kullanici beyani > turetilmis deger > model cikarimi.
 * Esit oncelikte yeni olan kazanir.
 */
export type Provenance = "explicit" | "inferred" | "model";

export interface FacetAssignment {
  optionId: string;
  source: Provenance;
  turn: number;
}

export interface BudgetAssignment {
  /** Kurus, tamsayi (CLAUDE.md). */
  minKurus: number | null;
  maxKurus: number | null;
  source: Provenance;
  turn: number;
}

/** Mevcut sozluk ayristiricisindan (Kademe 2) gelen, soru gerektirmeyen sinyaller. */
export interface LexicalSignals {
  color?: readonly string[];
  size_norm?: string;
  brand_include?: readonly string[];
  brand_exclude?: readonly string[];
  category_path?: string;
}

export type ShoppingIntent = "product" | "gift" | "open";

export type ClarificationStatus =
  /** Hala faydali bir soru var. */
  | "collecting"
  /** Yeterli bilgi var ya da soru butcesi bitti. */
  | "ready"
  /** Kullanici "sonuçları göster" dedi; en genis makul arama. */
  | "user_requested_results";

export interface AnsweredQuestion {
  questionId: string;
  /** `null`: atlandi. */
  optionId: string | null;
  turn: number;
}

export interface SearchState {
  version: 1;
  /** Konusmayi baslatan sorgu (domain degisirse yeni sorgu). */
  rawQuery: string;
  turn: number;
  intent: ShoppingIntent;
  domainId: string | null;
  /** Domain'i kim belirledi; model cikarimi acik beyani ezemez. */
  domainSource: Provenance | null;
  facets: Readonly<Record<string, FacetAssignment>>;
  skippedFacets: readonly string[];
  budget: BudgetAssignment | null;
  lexical: LexicalSignals;
  /** Ilk sorgudan kalan somut kelimeler: "iphone 16 kılıfı". */
  terms: readonly string[];
  constraints: {
    /** "ucuz", "uygun fiyatlı": sayiya cevrilmez, uydurulmaz. */
    pricePreference: "lower" | null;
  };
  pendingQuestionId: string | null;
  askCounts: Readonly<Record<string, number>>;
  answeredQuestions: readonly AnsweredQuestion[];
  clarificationStatus: ClarificationStatus;
}

// ---------------------------------------------------------------------------
// Girdiler ve karar sozlesmesi
// ---------------------------------------------------------------------------

export type ClarificationInput =
  /** Serbest metin: ilk sorgu ya da sorunun altindaki metin kutusu. */
  | { type: "text"; text: string }
  /** Sunulan seceneklerden biri. */
  | { type: "answer"; questionId: string; optionId: string }
  /** "Fark etmez" / "Emin değilim". */
  | { type: "skip"; questionId: string }
  /** "Sonuçları göster": kalan sorular atlanir. */
  | { type: "show_results" };

export const SKIP_OPTION_ID = "skip";

export interface ClarificationQuestionOption {
  id: string;
  label: string;
  selected: boolean;
}

export interface ClarificationQuestion {
  id: string;
  text: string;
  options: readonly ClarificationQuestionOption[];
  skipOption: { id: typeof SKIP_OPTION_ID; label: string };
  allowFreeText: true;
}

export interface Readiness {
  signals: number;
  signalsNeeded: number;
  missingEssential: readonly string[];
  questionsAsked: number;
  maxQuestions: number;
}

/**
 * Tek tur ciktisi. `clarify` durumunda da `query` doludur: docs/search.md
 * "Sonuçlar asla bekletilmez" - arayuz en olasi yorumla sonuclari gosterip
 * soruyu ustlerine koyabilir.
 */
export type ClarificationDecision =
  | {
      action: "clarify";
      state: SearchState;
      question: ClarificationQuestion;
      readiness: Readiness;
    }
  | {
      action: "search";
      state: SearchState;
      readiness: Readiness;
    };
