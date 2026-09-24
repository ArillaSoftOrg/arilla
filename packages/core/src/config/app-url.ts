/**
 * `APP_URL` tek okuma noktasi (Faz 8). Canonical (layout.tsx metadataBase),
 * robots.txt, sitemap'ler, urun JSON-LD `url`'i, giris e-postasi linki ve
 * alarm e-postalari hepsi `${origin}/yol` biciminde birlestirir - normalize
 * edilmezse sonda slash `//giris/dogrula` gibi bozuk URL uretir, `https://`
 * unutulursa `new URL` metadataBase'i dusurur.
 *
 * Cozumleme sirasi:
 *   1. `APP_URL` (elle ayarlanan, ozel alan adi geldiginde bu).
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` - Vercel'in kendisinin verdigi
 *      production host'u (protokolsuz, orn. `proje.vercel.app` veya ozel alan
 *      adi). Tahmin edilmis bir alan adi degil; kodda hicbir alan adi gomulu
 *      degil.
 *
 * `VERCEL_ENV === "production"` iken sonuc https olmak ve localhost olmamak
 * ZORUNDA; hicbir sey cozulmezse firlatir. Boylece Vercel production'da
 * localhost/sahte canonical asla uretilmez. Yerel `next build`/`next start`
 * (NODE_ENV=production ama VERCEL_ENV yok) http://localhost'a izin verir -
 * yerel QA calisir.
 *
 * Bicim hatasi sessizce yutulmaz, firlatilir: yanlis bir deger deploy'u
 * build'de durdurur - yanlis canonical ile canliya cikmaktan iyidir.
 */

const MISSING_MESSAGE = "APP_URL tanimli degil. .env.example dosyasina bakin.";

/** Cozumlemenin okudugu ortam degiskenleri. Testte `process.env` yerine verilir. */
export interface AppUrlEnv {
  readonly APP_URL?: string | undefined;
  readonly VERCEL_ENV?: string | undefined;
  readonly VERCEL_PROJECT_PRODUCTION_URL?: string | undefined;
  /** Vercel'in bu deploy'a ozel host'u (protokolsuz); yalnizca preview e-posta linkleri. */
  readonly VERCEL_URL?: string | undefined;
  // `process.env` dogrudan verilebilsin (aksi halde "weak type" hatasi).
  readonly [name: string]: string | undefined;
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "[::1]"]);

/**
 * Saf bicim kontrolu: bos/tanimsiz -> `undefined`; aksi halde yalnizca
 * protokol + host (+ port) kabul eder ve sondaki slash olmadan origin dondurur.
 * Yol, sorgu, hash veya kullanici bilgisi iceren deger firlatir.
 */
export function normalizeAppUrl(raw: string | undefined, name = "APP_URL"): string | undefined {
  const value = raw?.trim().replace(/^["']|["']$/g, "");
  if (!value) return undefined;
  // Kimlik bilgisi (`kullanici:parola@`) iceren deger hata mesajina, dolayisiyla
  // build/calisma zamani loglarina yazilmaz.
  const shown = value.includes("@") ? "<kimlik bilgisi iceren deger gizlendi>" : `"${value}"`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} gecerli bir URL degil (orn. https://alan-adi.com): ${shown}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} http:// veya https:// ile baslamali: ${shown}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} kullanici adi/parola icermemeli: ${shown}`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${name} yalnizca kok adres olmali, yol/sorgu icermemeli: ${shown}`);
  }
  return parsed.origin;
}

/** Vercel'in protokolsuz host'unu https origin'e cevirir. */
function vercelProductionOrigin(raw: string | undefined): string | undefined {
  const host = raw?.trim();
  if (!host) return undefined;
  const withProtocol = /^[a-z]+:\/\//i.test(host) ? host : `https://${host}`;
  return normalizeAppUrl(withProtocol, "VERCEL_PROJECT_PRODUCTION_URL");
}

/**
 * Tanimsizsa `undefined` - YALNIZCA eksik degerin guvenli oldugu yerler icin:
 * layout.tsx metadataBase (alan atlanir), robots.ts (Sitemap satiri atlanir),
 * urun JSON-LD `url` (alan atlanir), sitemap route'lari (500 doner). Bu yerler
 * goreli/yanlis URL yazmaz, sadece alani atlar. Vercel production'da ise
 * eksik deger burada da firlatir, yani `undefined` yalnizca yerel/test/preview
 * disi ortamlarda donebilir.
 */
export function readAppUrl(env: AppUrlEnv = process.env): string | undefined {
  const resolved =
    normalizeAppUrl(env.APP_URL) ?? vercelProductionOrigin(env.VERCEL_PROJECT_PRODUCTION_URL);

  if (env.VERCEL_ENV?.trim() === "production") {
    if (!resolved) {
      throw new Error(
        `${MISSING_MESSAGE} Vercel production'da APP_URL veya VERCEL_PROJECT_PRODUCTION_URL zorunlu.`,
      );
    }
    const { protocol, hostname } = new URL(resolved);
    if (protocol !== "https:") {
      throw new Error(`Vercel production'da site adresi https olmali: "${resolved}"`);
    }
    if (LOCAL_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
      throw new Error(`Vercel production'da site adresi localhost olamaz: "${resolved}"`);
    }
  }
  return resolved;
}

/**
 * `readAppUrl` ile ayni, ama tanimsizsa firlatir - URL uretmek zorunda olan
 * yerler (giris ve alarm e-postasi linkleri) icin.
 *
 * Vercel preview'da `APP_URL` yoksa link o deploy'un kendi adresine
 * (`VERCEL_URL`) gider: preview veritabanina yazilan giris token'i production
 * host'unda dogrulanamaz. Canonical/sitemap (`readAppUrl`) ise preview'da da
 * production host'unu gostermeye devam eder - SEO icin dogru olan bu.
 */
export function requireAppUrl(env: AppUrlEnv = process.env): string {
  if (env.VERCEL_ENV?.trim() === "preview" && !normalizeAppUrl(env.APP_URL)) {
    const previewOrigin = vercelProductionOrigin(env.VERCEL_URL);
    if (previewOrigin) return previewOrigin;
  }
  const value = readAppUrl(env);
  if (!value) throw new Error(MISSING_MESSAGE);
  return value;
}
