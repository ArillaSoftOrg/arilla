/**
 * Karar 0203 pilot olcum seti icin DETERMINISTIK sahte model (kuru kosu). Ag yok, anahtar yok.
 *
 * Amac model kalitesini TAKLIT etmek DEGIL, butun hatti (GeminiChatInterpreter -> interpretTurn ->
 * validateAnswer -> yedek -> kayit -> toplu olcum -> denetim sayfasi) cevrimdisi calistirmak ve
 * dogrulayicinin her red yolunu (forbidden_claim, unevidenced_number, quote_mismatch, schema)
 * tetiklemektir. Ciktilar girdi metninin karmasina baglidir: ayni girdi -> ayni cikti.
 *
 * Token sayilari karakterden tahmindir (`CHARS_PER_TOKEN`); gercek maliyet tahmini icin kullanilir
 * ama GERCEK MODELIN OLCUMU DEGILDIR.
 */
import { type ResultFact, validateAnswer } from "../chat/answer.ts";
import type {
  LlmCall,
  LlmCallOptions,
  LlmClient,
  LlmJsonRequest,
  LlmJsonResult,
} from "../llm/client.ts";
import { GEMINI_MODEL } from "../llm/model.ts";
import { estimateTokens } from "./chat-answer-pilot.ts";

/** Dusunme token'i varsayimi (thinking_level=minimal; gercek kosuda olculur). */
export const STUB_THOUGHT_TOKENS = 150;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cevaplanamayacak sorulari kaba kelimelerle taniyan sahte "model" sezgisi. */
const UNANSWERABLE_RE =
  /kaç|ağırlık|litre|saat|gün gider|uyumlu|uyar|uyum|dayan|sağlam|kalite|performans|ses |gürültü|koku|kalıcı|orijinal|güvenli|alerji|tahriş|garanti|yorum|yıldız|stok|indirim|kargo|iade|ignore|yoksay|talimat|film|şiir|hava|maç|çalışır|bpa|dermatolojik|kırışık|taban|kalıp|beden|iplik|karat|yaş|boyut|lümen|gecikme|sızdır/iu;

interface ParsedInput {
  facts: ResultFact[];
  question: string;
}

function parseInput(input: string): ParsedInput {
  try {
    const value = JSON.parse(input) as {
      result_facts?: ResultFact[];
      messages?: { role: string; text: string }[];
    };
    const messages = value.messages ?? [];
    return {
      facts: value.result_facts ?? [],
      question: messages.at(-1)?.text ?? "",
    };
  } catch {
    return { facts: [], question: "" };
  }
}

/** Ilk 2-3 kelimelik, dogrulayicidan gecen bir baslik alintisi (yoksa ilk 12 karakter). */
function titleQuote(fact: ResultFact, facts: readonly ResultFact[]): string {
  const words = fact.title.split(/\s+/).filter(Boolean);
  for (const size of [3, 2, 1]) {
    for (let start = 0; start + size <= Math.min(words.length, 6); start++) {
      const quote = words.slice(start, start + size).join(" ");
      if (quote.length < 4) continue;
      const probe = validateAnswer(
        {
          paragraphs: [
            {
              text: `${quote} ürünü listede yer alıyor.`,
              evidence: [{ item: fact.id, field: "title", quote }],
            },
          ],
        },
        facts,
      );
      if (probe.answer) return quote;
    }
  }
  return fact.title.slice(0, 12);
}

function validParagraphs(facts: readonly ResultFact[], variant: number) {
  const first = facts[variant % Math.max(1, facts.length)] as ResultFact;
  const quote = titleQuote(first, facts);
  const paragraphs: unknown[] = [
    {
      text: `${quote} ürünü ${first.store ?? "bir mağaza"} üzerinden listeleniyor.`,
      evidence: [
        { item: first.id, field: "title", quote },
        ...(first.store ? [{ item: first.id, field: "store", quote: first.store }] : []),
      ],
    },
  ];
  const priced = facts.find((fact) => fact.price_try !== null);
  if (priced?.price_try != null) {
    const priceQuote = titleQuote(priced, facts);
    paragraphs.push({
      text: `${priceQuote} ürününün fiyatı ${priced.price_try} TL olarak görünüyor.`,
      evidence: [
        { item: priced.id, field: "title", quote: priceQuote },
        { item: priced.id, field: "price", quote: String(priced.price_try) },
      ],
    });
  }
  return paragraphs;
}

function honestDecline(facts: readonly ResultFact[]) {
  const first = facts[0] as ResultFact;
  const quote = titleQuote(first, facts);
  return [
    {
      text: `Bu bilgi başlıklarda belirtilmemiş; ${quote} gibi ürünler için yalnızca başlık, mağaza ve fiyat verisi var.`,
      evidence: [{ item: first.id, field: "title", quote }],
    },
  ];
}

function answerTurn(paragraphs: unknown) {
  return {
    action: "answer",
    message: "Sonuçlara göre kısa bir karşılaştırma yaptım.",
    question: null,
    intent: null,
    answer: paragraphs === null ? null : { paragraphs },
  };
}

const SEARCH_TURN = {
  action: "search",
  message: "Tamam, bunu aramaya çevirip aşağıda gösteriyorum.",
  question: null,
  intent: { reset: false, clear: false, remove: [], query: "ürün" },
  answer: null,
};

export class DeterministicStubClient implements LlmClient {
  readonly modelVersion = GEMINI_MODEL;

  async generateJson(
    request: LlmJsonRequest,
    options: LlmCallOptions = {},
  ): Promise<LlmJsonResult> {
    const { facts, question } = parseInput(request.input);
    const roll = fnv1a(`${question}|${facts.map((f) => f.id).join(",")}`) % 100;
    let value: unknown;
    if (facts.length === 0) {
      // Gerceksiz (taban) tur: normal sohbet turu.
      value = { ...SEARCH_TURN, answer: undefined };
    } else if (UNANSWERABLE_RE.test(question)) {
      if (roll < 45) value = answerTurn(honestDecline(facts));
      else if (roll < 75) value = SEARCH_TURN;
      else if (roll < 88) {
        // Uydurma sayi: dogrulayici "unevidenced_number" ile atmali.
        const first = facts[0] as ResultFact;
        value = answerTurn([
          {
            text: `${titleQuote(first, facts)} ürünü yaklaşık 12 saat dayanıyor.`,
            evidence: [{ item: first.id, field: "title", quote: titleQuote(first, facts) }],
          },
        ]);
      } else {
        value = answerTurn([
          {
            text: "Bu ürün kesinlikle en iyi seçenek ve her cihazla uyumlu çalışıyor.",
            evidence: [
              { item: "p1", field: "title", quote: (facts[0] as ResultFact).title.slice(0, 6) },
            ],
          },
        ]);
      }
    } else if (roll < 86) value = answerTurn(validParagraphs(facts, roll));
    else if (roll < 91) {
      value = answerTurn([
        {
          text: "Bu seçenek en iyi tercih olur, kesinlikle tavsiye ederim.",
          evidence: [
            { item: "p1", field: "title", quote: (facts[0] as ResultFact).title.slice(0, 6) },
          ],
        },
      ]);
    } else if (roll < 95) {
      value = answerTurn([
        {
          text: "Bu ürünün fiyatı 7777 TL olarak görünüyor ve stokta.",
          evidence: [
            { item: "p1", field: "title", quote: (facts[0] as ResultFact).title.slice(0, 6) },
          ],
        },
      ]);
    } else if (roll < 98) {
      value = answerTurn([
        {
          text: "Bu ürün başlıkta geçmeyen bir ifadeyle listeleniyor.",
          evidence: [{ item: "p1", field: "title", quote: "uydurma alinti ifadesi" }],
        },
      ]);
    } else value = answerTurn([]);

    const text = JSON.stringify(value);
    const inputChars =
      request.systemInstruction.length +
      request.input.length +
      JSON.stringify(request.schema).length;
    const usage = {
      inputTokens: estimateTokens(inputChars),
      outputTokens: estimateTokens(text.length),
      thoughtTokens: STUB_THOUGHT_TOKENS,
      totalTokens: 0,
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.thoughtTokens;
    const call: LlmCall = { modelVersion: GEMINI_MODEL, httpStatus: 200, usage };
    try {
      options.onCall?.(call);
    } catch {
      // Gozlemci hatasi istemciyi etkilemez (gercek istemciyle ayni).
    }
    return { value: JSON.parse(text) as unknown, usage, modelVersion: GEMINI_MODEL };
  }
}
