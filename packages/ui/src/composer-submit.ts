/**
 * Mesaj kutusu gonderim semantigi (docs/decisions/0079): ana sayfa kutusu ve sohbet ici
 * kutu AYNI kurallari kullanir. Tarayiciya/React'a bagimli degil; birim testlidir.
 *
 * - Metin ya da fotograf varsa gonderilir (metin bos olabilir: yalniz fotograf).
 * - Ikisi de yoksa hicbir sey olmaz (bos Enter).
 * - Mesgulken (gonderim suruyor) ikinci gonderim olmaz (cift Enter/tik).
 * - Fotograf secmek hicbir zaman gonderim sayilmaz (burada karar verilmez, secim ayri).
 */

export type ComposerSubmitDecision = "submit" | "noop";

export function resolveComposerSubmit(input: {
  text: string;
  hasImage: boolean;
  /** Gonderim suruyor ya da kutu kilitli. */
  busy?: boolean;
}): ComposerSubmitDecision {
  if (input.busy) return "noop";
  return input.text.trim() !== "" || input.hasImage ? "submit" : "noop";
}

/**
 * Cok satirli alanda Enter gonderir, Shift+Enter yeni satir ekler; IME birlestirmesini
 * onaylayan Enter (CJK, bazi mobil klavyeler, Safari `keyCode 229`) gondermez.
 */
export function isSubmitKey(event: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return (
    event.key === "Enter" &&
    event.shiftKey !== true &&
    event.isComposing !== true &&
    event.keyCode !== 229
  );
}
