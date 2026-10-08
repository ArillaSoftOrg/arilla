/**
 * Sohbette gorsel baglami (docs/decisions/0079 madde 6).
 *
 * Takip turlarinda gorselin kendisi degil, modelin gorselin ilk goruldugu turda
 * urettigi yapilandirilmis ozet baglama girer. Gorsel yalnizca sunlarda yeniden
 * eklenir ve HER ZAMAN yalnizca EN SON gorselli kullanici mesaji icin:
 *   (a) gorsel bu turun kendi mesajindaysa (ilk gorus),
 *   (b) o gorselin kayitli ozeti yoksa (tur yedege dustu / ozet uretilmedi),
 *   (c) kullanici mesaji gorsele acikca atif yapiyorsa.
 * Saf fonksiyonlar: veritabani ya da model bilmez; birim testlidir.
 */

/** Konusma basina en fazla gorsel eki (depolama ve kotuye kullanim siniri). */
export const CHAT_ATTACHMENTS_PER_CONVERSATION = 5;
/** `image_summary` icin ust sinir (karakter). */
export const IMAGE_SUMMARY_MAX = 300;

/** Karar mantiginin ihtiyac duydugu en az mesaj bicimi (`ChatMessageView` ile uyumlu). */
export interface ImageContextMessage {
  role: "user" | "assistant";
  /** Kullanici mesajinin eki. */
  attachmentId?: string | null;
  /** Asistan mesajinin, hangi eke ait oldugunu belirten kayitli ozeti. */
  imageSummary?: { attachmentId: string; text: string } | null;
  /** Kullanici mesajinin metni (gorsel-only ise bos). */
  content?: string;
}

export interface ImageContextDecision {
  /** Modele gorselin kendisi eklenecek mi? */
  sendImage: boolean;
  /** Gonderilecek (ya da ozetle temsil edilecek) gorselin sahibi: son gorselli kullanici mesaji. */
  attachmentId: string | null;
  /** `messages` icindeki sahip mesajin dizini; yoksa `-1`. */
  ownerIndex: number;
  /** Kayitli ozet (varsa). Gorsel gonderilmese de baglama girer. */
  summary: string | null;
}

const NONE: ImageContextDecision = {
  sendImage: false,
  attachmentId: null,
  ownerIndex: -1,
  summary: null,
};

/**
 * Kullanicinin gorsele atif yaptigi mesajlar: belirlenimci Turkce sozluk. Kasitli
 * olarak dar ve ucuz: yanlis pozitif yalnizca kucuk bir gorsel karosu ekler.
 */
const IMAGE_REFERENCE_RE =
  /(?:^|[^\p{L}])(?:foto(?:ğraf|graf|ğ)?\p{L}*|görsel\p{L}*|gorsel\p{L}*|resim\p{L}*|resmi\p{L}*|bunun|şunun|sunun|buna|şuna|suna|bundan|şundan|sundan|aynısı|aynisi|benzeri|benzerini)(?![\p{L}])/iu;

/** Metin gorsele atif yapiyor mu? */
export function refersToImage(text: string): boolean {
  if (text.length === 0) return false;
  return IMAGE_REFERENCE_RE.test(text.toLocaleLowerCase("tr-TR"));
}

/**
 * En son gorselli kullanici mesajini bulur (pencere icinde) ve gorselin gonderilip
 * gonderilmeyecegine karar verir. `windowSize`: modele giden son mesaj sayisi.
 * Son mesaj, bu turun kullanici girdisidir.
 */
export function decideContextImage(
  messages: readonly ImageContextMessage[],
  windowSize: number,
): ImageContextDecision {
  const start = Math.max(0, messages.length - windowSize);
  let ownerIndex = -1;
  for (let i = messages.length - 1; i >= start; i--) {
    const message = messages[i];
    if (message?.role === "user" && message.attachmentId) {
      ownerIndex = i;
      break;
    }
  }
  const owner = ownerIndex >= 0 ? messages[ownerIndex] : undefined;
  if (!owner?.attachmentId) return NONE;
  const attachmentId = owner.attachmentId;

  // Sahipten SONRAKI en yeni asistan ozeti, ayni eke ait olmali.
  let summary: string | null = null;
  for (let i = messages.length - 1; i > ownerIndex; i--) {
    const message = messages[i];
    if (message?.role === "assistant" && message.imageSummary?.attachmentId === attachmentId) {
      summary = message.imageSummary.text;
      break;
    }
  }

  const isThisTurn = ownerIndex === messages.length - 1;
  const last = messages.at(-1);
  const referenced = last?.role === "user" && refersToImage(last.content ?? "");
  return {
    sendImage: isThisTurn || summary === null || referenced,
    attachmentId,
    ownerIndex,
    summary,
  };
}

/** Modelin `image_summary` ciktisini temizler; gecersizse `undefined` (tur yine gecerli). */
export function cleanImageSummary(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  if (/https?:\/\/|\bwww\./i.test(text)) return undefined;
  return text.slice(0, IMAGE_SUMMARY_MAX);
}
