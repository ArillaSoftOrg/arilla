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
 * - AliExpress: katalog zaten 800+ piksel orijinal tutuyor; DONUSUM YOK.
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

/**
 * `url` icin dogrulanmis daha yuksek cozunurluklu varyantlari dondurur; kaynak
 * taninmiyorsa, URL gecersizse ya da zaten yeterince buyukse `null`.
 */
export function resolveImageVariants(url: string | null | undefined): ImageVariants | null {
  if (typeof url !== "string" || url.length === 0 || url.length > 2048) return null;
  return resolveHepsiburada(url);
}
