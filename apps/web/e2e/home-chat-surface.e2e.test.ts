/**
 * Ana sayfa + sohbet tek yuzey (karar 0204): gercek Chrome (CDP), YEREL sunucu ve veritabani.
 * Sunucu `CHAT_DISCOVERY_ENABLED=true PRODUCT_ACCESS=open` ile acilmalidir; model anahtari gerekmez
 * (ilk tur hata verebilir, sinanan sey yuzey, adres ve gezinmedir).
 *
 *   E2E_BASE_URL=http://localhost:3332 DATABASE_URL_OWNER=<yerel> SESSION_SECRET=<ayni> \
 *     pnpm --filter @arilla/web test:e2e home-chat-surface
 *
 * `E2E_SHOTS=<dizin>` verilirse masaustu/mobil ekran goruntuleri oraya yazilir (istege bagli).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createConversation, generateRawToken, hashToken } from "@arilla/core";
import { rejectAll, serializeConsent } from "@arilla/core/cookie-consent";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Browser, type CdpPage, findChrome } from "./cdp.ts";

function requireLocal(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} tanımlı değil`);
  const host = new URL(value).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); E2E yalnızca yerelde çalışır.`);
  }
  return value;
}

const BASE = requireLocal("E2E_BASE_URL").replace(/\/+$/, "");
const CHROME = findChrome();
const TAG = `homechat${Date.now().toString(36)}`;
const db = createDatabase(requireLocal("DATABASE_URL_OWNER"));
const client = db.$client;
const SHOTS = process.env.E2E_SHOTS;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let userId = 0;
let token = "";
let existingId = "";
let browser: Browser | undefined;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

async function until(
  page: CdpPage,
  check: () => Promise<boolean>,
  what: string,
  ms = 20_000,
): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(150);
  }
  const state = await page.evaluate<string>(
    "JSON.stringify({url: location.href, tail: document.body.innerText.slice(0, 300)})",
  );
  throw new Error(`zaman aşımı: ${what} ${state}`);
}

async function newPage(opts: {
  signedIn: boolean;
  mobile?: boolean;
  scheme?: "light" | "dark";
}): Promise<CdpPage> {
  if (!browser) throw new Error("tarayıcı yok");
  const page = await browser.newPage();
  await page.setViewport(
    opts.mobile ? { width: 390, height: 844, touch: true } : { width: 1280, height: 860 },
  );
  if (opts.scheme) await page.setColorScheme(opts.scheme);
  await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
  if (opts.signedIn) await page.setCookie(BASE, "session", token);
  return page;
}

const hasHero = (page: CdpPage) =>
  page.evaluate<boolean>("Boolean(document.getElementById('anasayfa-baslik'))");
const search = (page: CdpPage) => page.evaluate<string>("location.search");
const pathname = (page: CdpPage) => page.evaluate<string>("location.pathname");
const bodyText = (page: CdpPage) => page.evaluate<string>("document.body.innerText");
const noHorizontalScroll = (page: CdpPage) =>
  page.evaluate<boolean>("document.documentElement.scrollWidth <= window.innerWidth + 1");

async function submitFromHero(page: CdpPage, text: string): Promise<void> {
  await page.goto(`${BASE}/`);
  await until(page, () => hasHero(page), "ana sayfa hero");
  await wait(1500); // hidrasyon
  const filled = await page.evaluate<boolean>(`(() => {
    const input = document.querySelector('textarea');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(text)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  expect(filled).toBe(true);
  await wait(200);
  const clicked = await page.evaluate<boolean>(`(() => {
    const form = document.querySelector('textarea')?.closest('form');
    const btn = form?.querySelector('button[type=submit]');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  expect(clicked).toBe(true);
}

async function shot(page: CdpPage, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(await page.screenshot(), "base64"));
}

beforeAll(async () => {
  if (!CHROME) return;
  const user = await q<{ id: string }>(
    "INSERT INTO app_user (email, role) VALUES ($1, 'user') RETURNING id",
    [`${TAG}@test.local`],
  );
  userId = Number(user[0]?.id);
  token = generateRawToken();
  await q(
    "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
    [userId, hashToken(token)],
  );
  const created = await createConversation(db, { userId, message: "siyah ceket" });
  if (created.status !== "created") throw new Error(`sohbet oluşmadı: ${created.status}`);
  existingId = created.conversationId;
  browser = await Browser.launch(CHROME);
});

afterAll(async () => {
  await browser?.close();
  if (userId) {
    await q("DELETE FROM api_usage WHERE user_id = $1", [userId]);
    await q("DELETE FROM app_user WHERE id = $1", [userId]);
  }
  await client.end();
});

describe.skipIf(!CHROME)("ana sayfa ve sohbet tek yüzey (karar 0204)", () => {
  it("masaüstü: ana sayfadan sohbet başlar, adres /?s=<id>; yenileme, geri ve ileri çalışır", async () => {
    const page = await newPage({ signedIn: true });
    await page.goto(`${BASE}/`);
    await until(page, () => hasHero(page), "ana sayfa hero");
    await shot(page, "00-ana-sayfa-masaustu");
    await submitFromHero(page, "kadın dolgu topuk terlik");
    await until(page, async () => (await search(page)).startsWith("?s="), "sohbet adresi");
    expect(await pathname(page)).toBe("/");
    expect(await hasHero(page)).toBe(false);
    const created = (await search(page)).slice(3, 39);
    expect(created).toMatch(/^[0-9a-f-]{36}$/);
    await until(
      page,
      async () => (await bodyText(page)).includes("kadın dolgu topuk terlik"),
      "kullanıcı mesajı görünür",
    );
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, "01-sohbet-masaustu");

    // Yenileme: durum URL'de, aynı konuşma.
    await page.goto(`${BASE}/?s=${created}`);
    await until(
      page,
      async () => (await bodyText(page)).includes("dolgu topuk"),
      "yenileme sonrası konuşma",
    );

    // Geri: ana sayfa (hero), ileri: konuşma.
    await page.evaluate<boolean>("(history.back(), true)");
    await until(
      page,
      async () => (await search(page)) === "" && (await hasHero(page)),
      "geri -> ana sayfa",
    );
    await page.evaluate<boolean>("(history.forward(), true)");
    await until(page, async () => (await search(page)).startsWith("?s="), "ileri -> sohbet");
  });

  it("mobil ve koyu tema: sohbet yüzeyi ve ana sayfa açılır, yatay taşma yok", async () => {
    const page = await newPage({ signedIn: true, mobile: true, scheme: "dark" });
    await page.goto(`${BASE}/?s=${existingId}`);
    await until(page, async () => (await bodyText(page)).includes("siyah ceket"), "mobil konuşma");
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, "02-sohbet-mobil-koyu");
    await page.goto(`${BASE}/`);
    await until(page, () => hasHero(page), "mobil ana sayfa");
    expect(await noHorizontalScroll(page)).toBe(true);
    await shot(page, "03-ana-sayfa-mobil-koyu");
  });

  it("/sohbet 404; /sohbet/<id> /?s=<id>'ye taşınır (sirala ve ac korunur); /sohbet/yeni ana sayfaya", async () => {
    const page = await newPage({ signedIn: true });
    await page.goto(`${BASE}/`);
    expect(await page.evaluate<number>("fetch('/sohbet').then((r) => r.status)")).toBe(404);
    await page.goto(`${BASE}/sohbet/${existingId}?sirala=firsat&ac=2`);
    await until(
      page,
      async () => (await search(page)).startsWith("?s="),
      "eski adres yönlendirmesi",
    );
    expect(await pathname(page)).toBe("/");
    expect(await search(page)).toContain(`s=${existingId}`);
    expect(await search(page)).toContain("sirala=firsat");
    expect(await search(page)).toContain("ac=2");
    await page.goto(`${BASE}/sohbet/yeni`);
    await until(page, () => hasHero(page), "/sohbet/yeni -> ana sayfa");
    expect(await pathname(page)).toBe("/");
  });

  it("anonim: /?q= arama turu açılır; /?s= girişe yönlenir ve next ile geri döner", async () => {
    // Çerezler tarayıcı genelindedir: anonim ziyaretçi için ayrı bir tarayıcı açılır.
    const anonymous = await Browser.launch(CHROME as string);
    try {
      const page = await anonymous.newPage();
      await page.setViewport({ width: 1280, height: 860 });
      await page.setCookie(
        BASE,
        "cookie_consent",
        encodeURIComponent(serializeConsent(rejectAll())),
      );
      await anonymousFlow(page);
    } finally {
      await anonymous.close();
    }
  });

  async function anonymousFlow(page: CdpPage): Promise<void> {
    await page.goto(`${BASE}/?q=kablosuz+kulaklik`);
    await until(
      page,
      async () => (await bodyText(page)).includes("kablosuz kulaklik"),
      "anonim arama turu",
    );
    expect(await pathname(page)).toBe("/");
    await page.goto(`${BASE}/?s=${existingId}`);
    await until(page, async () => (await pathname(page)) === "/giris", "girişe yönlendirme");
    expect(decodeURIComponent(await search(page))).toContain(`next=/?s=${existingId}`);
  }

  it("noindex: /?s= ve /?q= başlık ve meta ile dizinlenmez; parametresiz / dizinlenir", async () => {
    const page = await newPage({ signedIn: true });
    const head = async (path: string) =>
      page.evaluate<string>(
        `fetch(${JSON.stringify(path)}).then(async (r) => JSON.stringify({ tag: r.headers.get('x-robots-tag'), html: (await r.text()).match(/<meta name="robots"[^>]*>/)?.[0] ?? '' }))`,
      );
    await page.goto(`${BASE}/`);
    const priv = JSON.parse(await head(`/?s=${existingId}`)) as { tag: string; html: string };
    expect(priv.tag).toContain("noindex");
    expect(priv.html).toContain("noindex");
    const searchTour = JSON.parse(await head("/?q=ceket")) as { tag: string; html: string };
    expect(searchTour.tag).toContain("noindex");
    const home = JSON.parse(await head("/")) as { tag: string | null; html: string };
    expect(home.tag ?? "").not.toContain("noindex");
    expect(home.html).not.toContain("noindex");
  });
});
