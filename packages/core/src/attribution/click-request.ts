/**
 * Yonlendirme istegi siniflandirmasi ve adres satirindan gelen metadata'nin
 * dogrulanmasi. Saf fonksiyonlar: DB ve ag yok.
 *
 * Amac: gercek bir kullanici tiklamasi olmayan istekler (tarayici onyukleme,
 * HEAD, bilinen botlar) `click` satiri uretmesin - aksi halde tiklama sayilari
 * ve attribution sismis olur. Bu istekler merchant'a yonlendirilmez; dolayisiyla
 * "her dis cikis click uretir" kurali (CLAUDE.md kural 8) bozulmaz.
 */

export type ClickRequestKind = "human" | "prefetch" | "bot" | "head";

/** Bilinen bot kaliplari. Bilerek dar: `bot` alt dizisi tek basina yetmez ("Cubot" gibi cihaz adlari gercek kullanicidir); bot UA'lari `bot/`, `bot;`, `+http` kalibini tasir. */
const BOT_UA =
  /bot[/;)-]|bot \(|\+https?:|crawler|spider|slurp|facebookexternalhit|embedly|headless|lighthouse|^curl\/|^wget\/|python-requests|go-http-client|^okhttp\/|^java\//i;

export function classifyClickRequest(input: {
  method: string;
  headers: { get(name: string): string | null };
}): ClickRequestKind {
  if (input.method.toUpperCase() === "HEAD") return "head";
  const h = input.headers;
  const purpose = `${h.get("sec-purpose") ?? ""} ${h.get("purpose") ?? ""}`.toLowerCase();
  if (
    /prefetch|prerender|preview/.test(purpose) ||
    h.get("x-moz")?.toLowerCase() === "prefetch" ||
    h.get("x-purpose")?.toLowerCase() === "preview"
  ) {
    return "prefetch";
  }
  const ua = h.get("user-agent");
  // UA'siz istek tarayici degildir.
  if (!ua || BOT_UA.test(ua)) return "bot";
  return "human";
}

/** `result_position` SMALLINT'tir; 1 tabanli, makul ust sinir. Gecersizse NULL. */
export const MAX_RESULT_POSITION = 500;

/** Yalnizca liste yuzeylerinde anlamli; adres satiri guvenilmez girdidir. */
const POSITIONAL_SURFACES = new Set(["search", "collection", "compare"]);

export function parseResultPosition(
  raw: string | null | undefined,
  surface: string | null | undefined,
): number | null {
  if (!raw || !surface || !POSITIONAL_SURFACES.has(surface)) return null;
  if (!/^[1-9]\d{0,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= MAX_RESULT_POSITION ? n : null;
}
