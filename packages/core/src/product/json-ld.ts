/**
 * `<script type="application/ld+json">` içine gömülecek JSON. Ürün başlığı
 * merchant feed'inden gelir (üçüncü taraf verisi): düz `JSON.stringify`
 * çıktısındaki `</script>` etiketi kapatır ve sayfaya betik enjekte eder.
 *
 * `<`, `>`, `&` ve U+2028/U+2029 `\uXXXX` kaçışına çevrilir. Sonuç hâlâ
 * geçerli JSON'dur (JSON.parse aynı değeri döndürür); yalnızca HTML ayrıştırıcı
 * artık etiket, varlık ya da satır sonu görmez.
 */
/** U+2028/U+2029: JSON'da geçerli, eski JS ayrıştırıcılarında satır sonu. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

const JSON_LD_UNSAFE = new RegExp(`[<>&${LINE_SEPARATOR}${PARAGRAPH_SEPARATOR}]`, "g");

/** Ters bölü karakter koduyla kurulur: kaynakta kaçış dizisi yok, yanlış okunamaz. */
const BACKSLASH = String.fromCharCode(92);

function unicodeEscape(ch: string): string {
  return `${BACKSLASH}u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}

export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value).replace(JSON_LD_UNSAFE, unicodeEscape);
}
