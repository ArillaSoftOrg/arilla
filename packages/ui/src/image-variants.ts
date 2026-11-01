/**
 * Kaynak bazli gorsel varyanti cozumleme (karar 0166).
 *
 * Katalogda saklanan `primary_image_url` DEGISMEZ; varyant URL'si okuma/cizim
 * aninda turetilir. Yalnizca boyutu URL'de tasiyan ve bu bicimde DOGRULANMIS
 * CDN'ler icin donusum yapilir; taninmayan her URL `null` doner ve oldugu gibi
 * kullanilir (guvenli varsayilan).
 *
 * Dogrulanan kaynaklar:
 * - Hepsiburada `productimages.hepsiburada.net/s/{n}/{W}-{H}/{id}.jpg`: katalogda
 *   kucuk resim (222-222, 300-400) kayitli. Ayni yolda W-H degistirilince ayni
 *   urunun buyuk surumu gelir (300..1000 piksel kare ve 3:4 dikey icin 200 donuldu;
 *   cok buyuk boyut 400 doner, bu yuzden ust sinir 1000).
 * - AliExpress `ae-pic-a1.aliexpress-media.com/kf/<kimlik>.<uzanti>` (karar 0167):
 *   katalog 800+ piksel ORIJINAL tutuyor (orneklemde en uzun kenar medyani ~1000 px,
 *   en buyuk ~2900 px); kartta 130-320 CSS px gosterilirken tam dosya iniyordu.
 *   Tam URL'nin sonuna `_{N}x{N}.jpg` eklenince N x N kutusuna SIGAN kucultulmus
 *   dosya gelir (oran korunur). Dogrulanan: N = 220/300/350/480/640/720/960/1200 (200 +
 *   gercek yeniden boyutlandirma; orijinalin ustune BUYUTMEZ); 1200 uzerinde
 *   (1600/1800/...) ve listede olmayan boyutlarda CDN orijinali doner - bu yuzden
 *   merdiven dogrulanmis basamaklarla 1200'de biter. URL aileleri `S<32hex><harf>`, `H<32hex><harf>`,
 *   `A<32hex><harf>` ve eski `HTB1...`; hepsinde ayni davranis olculdu.
 *   Yalnizca `aliexpress` secenegi acikken (bayrak, varsayilan KAPALI) uygulanir.
 */

export interface ImageVariants {
  /** Katalogdaki ilk URL; yuklenemezse son care. */
  original: string;
  /** `srcset` yoksa/destek yoksa kullanilan makul tek boyut. */
  src: string;
  /** `src` ile ayni gorselin `w` tanimlayicili adaylari (artan sirada). */
  srcSet: string;
}

/** Dogrulanan Hepsiburada kart/detay genislikleri (piksel). */
const HEPSIBURADA_WIDTHS = [300, 450, 680, 1000] as const;
/** Tek-boyut (`srcset`siz) kullanimda secilen genislik. */
const HEPSIBURADA_DEFAULT_WIDTH = 450;
/** Kaynak zaten bu genislikte ya da buyukse donusum yapilmaz. */
const HEPSIBURADA_MAX_UPGRADE_FROM = 600;
/** Dikey/yatay oran siniri: bunun disi beklenmeyen bicimdir, dokunulmaz. */
const HEPSIBURADA_MIN_RATIO = 0.5;
const HEPSIBURADA_MAX_RATIO = 2;

const HEPSIBURADA_URL =
  /^https:\/\/productimages\.hepsiburada\.net\/s\/(\d{1,4})\/(\d{2,4})-(\d{2,4})\/([A-Za-z0-9_-]{1,64})\.(jpg|jpeg|png|webp)$/;

function hepsiburadaVariantUrl(
  shard: string,
  width: number,
  ratio: number,
  id: string,
  ext: string,
): string {
  const height = Math.round(width * ratio);
  return `https://productimages.hepsiburada.net/s/${shard}/${width}-${height}/${id}.${ext}`;
}

/**
 * Dogrulanan AliExpress genislikleri (piksel). SADECE bunlar kullanilir: CDN yalnizca belirli
 * boyutlari yeniden boyutlandirir; desteklenmeyen N (400, 560, 1000, 1100, 1600, ...) HATA
 * DONMEZ, sessizce tam ORIJINAL dosyayi doner (olculdu). Yeni boyut eklemeden once 4 farkli
 * orijinalde `max(w,h) === min(N, orijinal)` ile dogrulanmali.
 */
const ALIEXPRESS_WIDTHS = [220, 300, 350, 480, 640, 720, 960, 1200] as const;
/** Tek-boyut (`srcset`siz) kullanimda secilen genislik. */
const ALIEXPRESS_DEFAULT_WIDTH = 640;

const ALIEXPRESS_URL =
  /^https:\/\/ae-pic-a1\.aliexpress-media\.com\/kf\/(?:[SHA][0-9a-f]{32}[A-Za-z0-9]|HTB1[A-Za-z0-9]{16,40})\.(?:jpg|jpeg|png)$/;

function aliexpressVariantUrl(url: string, width: number): string {
  return `${url}_${width}x${width}.jpg`;
}

function resolveAliexpress(url: string): ImageVariants | null {
  if (!ALIEXPRESS_URL.test(url)) return null;
  return {
    original: url,
    src: aliexpressVariantUrl(url, ALIEXPRESS_DEFAULT_WIDTH),
    srcSet: ALIEXPRESS_WIDTHS.map((w) => `${aliexpressVariantUrl(url, w)} ${w}w`).join(", "),
  };
}

function resolveHepsiburada(url: string): ImageVariants | null {
  const match = HEPSIBURADA_URL.exec(url);
  if (!match) return null;
  const [, shard, rawWidth, rawHeight, id, ext] = match;
  if (shard === undefined || rawWidth === undefined || rawHeight === undefined) return null;
  if (id === undefined || ext === undefined) return null;
  const sourceWidth = Number(rawWidth);
  const sourceHeight = Number(rawHeight);
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return null;
  if (sourceWidth >= HEPSIBURADA_MAX_UPGRADE_FROM) return null;
  const ratio = sourceHeight / sourceWidth;
  if (ratio < HEPSIBURADA_MIN_RATIO || ratio > HEPSIBURADA_MAX_RATIO) return null;

  const widths = HEPSIBURADA_WIDTHS.filter((w) => w >= sourceWidth);
  const srcSet = widths
    .map((w) => `${hepsiburadaVariantUrl(shard, w, ratio, id, ext)} ${w}w`)
    .join(", ");
  return {
    original: url,
    src: hepsiburadaVariantUrl(shard, HEPSIBURADA_DEFAULT_WIDTH, ratio, id, ext),
    srcSet,
  };
}

export interface ImageVariantOptions {
  /**
   * AliExpress CDN varyantlari (karar 0167). Varsayilan KAPALI: bayrak
   * (`IMAGE_VARIANTS_ALIEXPRESS_ENABLED`) sunucuda okunur ve bilesene prop olarak gelir;
   * kapaliyken AliExpress URL'si `null` doner ve bugunku gibi orijinal kullanilir.
   */
  aliexpress?: boolean;
}

/**
 * `url` icin dogrulanmis alternatif boyutlari dondurur; kaynak taninmiyorsa, URL
 * gecersizse, zaten yeterince buyukse ya da kaynak bayragi kapaliysa `null`.
 * Hepsiburada her zaman acik (karar 0166); AliExpress `options.aliexpress` ister.
 */
export function resolveImageVariants(
  url: string | null | undefined,
  options: ImageVariantOptions = {},
): ImageVariants | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return null;
  return resolveHepsiburada(url) ?? (options.aliexpress ? resolveAliexpress(url) : null);
}
