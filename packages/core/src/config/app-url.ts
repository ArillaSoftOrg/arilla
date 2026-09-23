/**
 * `APP_URL` tek okuma noktasi (Faz 8). Canonical, sitemap, robots, giris
 * e-postasi linki ve alarm e-postalari hepsi `${APP_URL}/yol` biciminde
 * birlestirir - normalize edilmezse sonda slash `//giris/dogrula` gibi
 * bozuk URL uretir, `https://` unutulursa `new URL` metadataBase'i dusurur.
 *
 * Bicim hatasi sessizce yutulmaz, firlatilir: `robots.txt` ve `sitemap.xml`
 * build aninda uretildigi icin yanlis bir deger deploy'u build'de durdurur -
 * yanlis canonical ile canliya cikmaktan iyidir.
 */

const MISSING_MESSAGE = "APP_URL tanimli degil. .env.example dosyasina bakin.";

/**
 * Tanimsiz/bos ise `undefined` (cagiran taraf alani atlar, bkz. layout.tsx
 * metadataBase). Tanimliysa yalnizca protokol + host (+ port) kabul eder ve
 * sondaki slash olmadan origin dondurur.
 */
export function readAppUrl(raw: string | undefined = process.env.APP_URL): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`APP_URL gecerli bir URL degil (orn. https://alan-adi.com): "${value}"`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`APP_URL http:// veya https:// ile baslamali: "${value}"`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username) {
    throw new Error(`APP_URL yalnizca kok adres olmali, yol/sorgu icermemeli: "${value}"`);
  }
  return parsed.origin;
}

/** `readAppUrl` ile ayni, ama tanimsizsa firlatir - URL uretmek zorunda olan yerler icin. */
export function requireAppUrl(raw: string | undefined = process.env.APP_URL): string {
  const value = readAppUrl(raw);
  if (!value) throw new Error(MISSING_MESSAGE);
  return value;
}
