/**
 * Testlerin üretim (ya da herhangi bir uzak) veritabanına/Redis'e bağlanmasını
 * ENGELLER - fail-closed. Kök `.env` üretim adreslerini taşır; testte
 * `DATABASE_URL`/`REDIS_URL` yerele çevrilmezse bağlantı kurulmadan önce
 * hata verilir.
 *
 * İzin listesi YALNIZCA yerel makine adresleridir (`localhost`, loopback);
 * tanınmayan, çözümlenemeyen ya da boş her şey reddedilir. Bilinen üretim
 * barındırıcı işaretleri ayrıca adlandırılır (daha açık mesaj için), ama
 * koruma onlara bağlı değildir. Hata mesajı host/parola/proje kimliği
 * İÇERMEZ; yalnızca değişken adını taşır.
 *
 * `createDatabase` ve `getRedis` bu korumayı yalnızca test sürecinde
 * (`VITEST` tanımlı ya da `NODE_ENV=test`) uygular; üretim yolu etkilenmez.
 */
const LOCAL_HOSTS: readonly string[] = ["localhost", "127.0.0.1", "::1", "[::1]"];
const KNOWN_REMOTE_MARKERS =
  /supabase|pooler|vercel|neon\.tech|amazonaws\.com|render\.com|railway/i;

export class TestIsolationError extends Error {
  constructor(name: string, reason: "remote" | "known_remote" | "unparseable") {
    const why =
      reason === "known_remote"
        ? "bilinen bir uzak/üretim barındırıcısını gösteriyor"
        : reason === "unparseable"
          ? "çözümlenemiyor"
          : "yerel makineyi göstermiyor";
    super(
      `${name} ${why}; testler yalnızca yerel veritabanı/Redis ile çalışır. ` +
        "Yerel adresi bu komutta aynı anda verin (bkz. infra/docker-compose.yml). Host gösterilmez.",
    );
    this.name = "TestIsolationError";
  }
}

export function isTestRuntime(env: Record<string, string | undefined> = process.env): boolean {
  return env.VITEST !== undefined || env.NODE_ENV === "test";
}

/** Yerel değilse fırlatır. Boş/tanımsız değer çağıranın işidir (başka hata verir). */
export function assertIsolatedTestUrl(name: string, url: string): void {
  let host: string;
  try {
    host = new URL(url.trim().replace(/^["']|["']$/g, "")).hostname.toLowerCase();
  } catch {
    throw new TestIsolationError(name, "unparseable");
  }
  if (KNOWN_REMOTE_MARKERS.test(host)) throw new TestIsolationError(name, "known_remote");
  if (!LOCAL_HOSTS.includes(host)) throw new TestIsolationError(name, "remote");
}

/** Tanımlı olan bağlantı değişkenlerinin hepsini denetler (setup dosyaları için). */
export function assertIsolatedTestEnv(env: Record<string, string | undefined> = process.env): void {
  for (const name of ["DATABASE_URL", "DATABASE_URL_OWNER", "REDIS_URL"]) {
    const value = env[name];
    if (value) assertIsolatedTestUrl(name, value);
  }
}
