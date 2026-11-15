/**
 * Sohbet blok düzeni v2 (karar 0200): çalışan Next sunucusu + gerçek başsız Chrome (CDP).
 * Yalnızca YEREL veritabanı ve sunucu; model sahtedir. Sunucu
 * `CHAT_DISCOVERY_ENABLED=true CHAT_UX_V2=true PRODUCT_ACCESS=open` ile açılmalıdır.
 *
 *   E2E_BASE_URL=http://localhost:3332 DATABASE_URL_OWNER=<yerel> SESSION_SECRET=<aynı> \
 *     pnpm --filter @arilla/web test:e2e chat-ux-v2
 */
import {
  type ChatInterpreter,
  createConversation,
  generateRawToken,
  hashToken,
  processPendingTurn,
  submitUserMessage,
} from "@arilla/core";
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
const TAG = `uxv${Date.now().toString(36)}`;
const db = createDatabase(requireLocal("DATABASE_URL_OWNER"));
const client = db.$client;
const PRODUCT_COUNT = 40;
const MERCHANTS = 3;
const usage = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let userId = 0;
let token = "";
let browser: Browser | undefined;
let page: CdpPage;
const merchantIds: number[] = [];
const productIds: number[] = [];

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

function scripted(intent: Record<string, unknown>): ChatInterpreter {
  return {
    modelVersion: "e2e-fake",
    async interpret() {
      return {
        value: {
          action: "search",
          message: "Aşağıda arıyorum.",
          question: null,
          intent: { reset: false, clear: false, remove: [], ...intent },
        },
        usage,
        modelVersion: "e2e-fake",
      };
    },
  };
}

async function seedCatalog(): Promise<void> {
  for (let m = 0; m < MERCHANTS; m++) {
    const row = await q<{ id: string }>(
      `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
       VALUES ($1, $2, $3, 'xml_feed', 80) RETURNING id`,
      [`${TAG}-m${m}`, `Mağaza ${m + 1}`, `${TAG}-m${m}.test`],
    );
    merchantIds.push(Number(row[0]?.id));
  }
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const price = 10_000 + i * 500;
    const product = await q<{ id: string }>(
      `INSERT INTO product (slug, title, min_price, primary_image_url, offer_count)
       VALUES ($1, $2, $3, $4, 1) RETURNING id`,
      [`${TAG}-p${i}`, `${TAG} lamba modeli ${i}`, price, `https://img.test/${TAG}/${i}.jpg`],
    );
    const productId = Number(product[0]?.id);
    productIds.push(productId);
    await q(
      `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [
        merchantIds[i % MERCHANTS],
        productId,
        `${TAG}-o${i}`,
        `https://${TAG}-m${i % MERCHANTS}.test/${i}`,
        `${TAG} lamba modeli ${i}`,
        price,
      ],
    );
  }
}

/** İki aramalı sohbet: ilk arama ürünlü (seq 2), ikinci arama ürünsüz (seq 4, en yeni). */
async function twoSearchConversation(): Promise<string> {
  const created = await createConversation(db, { userId, message: `${TAG} lamba` });
  if (created.status !== "created") throw new Error(created.status);
  const id = created.conversationId;
  const first = await processPendingTurn(db, {
    userId,
    conversationId: id,
    interpreter: scripted({ query: `${TAG} lamba` }),
  });
  if (first.status !== "answered") throw new Error(`ilk tur: ${first.status}`);
  const sent = await submitUserMessage(db, {
    userId,
    conversationId: id,
    request: { kind: "text", text: `${TAG}zz bambaşka` },
  });
  if (sent.status !== "queued") throw new Error(`ikinci mesaj: ${sent.status}`);
  const second = await processPendingTurn(db, {
    userId,
    conversationId: id,
    interpreter: scripted({ reset: true, query: `${TAG}zz bambaşka` }),
  });
  if (second.status !== "answered") throw new Error(`ikinci tur: ${second.status}`);
  return id;
}

async function oneSearchConversation(): Promise<string> {
  const created = await createConversation(db, { userId, message: `${TAG} lamba` });
  if (created.status !== "created") throw new Error(created.status);
  const first = await processPendingTurn(db, {
    userId,
    conversationId: created.conversationId,
    interpreter: scripted({ query: `${TAG} lamba` }),
  });
  if (first.status !== "answered") throw new Error(`ilk tur: ${first.status}`);
  return created.conversationId;
}

const cardCount = () =>
  page.evaluate<number>(
    `new Set([...document.querySelectorAll('a[href^="/urun/"]')].map((a) => a.getAttribute('href'))).size`,
  );
const textOf = (selector: string) =>
  page.evaluate<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`);
const buttonByText = (text: string) =>
  page.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(${JSON.stringify(text)}));
    if (!el) return false;
    el.click();
    return true;
  })()`);
async function until(check: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(200);
  }
  const tail = await page.evaluate<string>("document.body.innerText.slice(-500)");
  throw new Error(`zaman aşımı: ${what} :: ${tail}`);
}
async function open(path: string): Promise<void> {
  await page.goto(`${BASE}${path}`);
  await wait(3500);
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
  await seedCatalog();
  browser = await Browser.launch(CHROME);
  page = await browser.newPage();
  await page.setCookie(BASE, "session", token);
  await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
});

afterAll(async () => {
  await browser?.close();
  if (productIds.length > 0) {
    await q("DELETE FROM offer WHERE product_id = ANY($1)", [productIds]);
    await q("DELETE FROM product WHERE id = ANY($1)", [productIds]);
  }
  if (merchantIds.length > 0) await q("DELETE FROM merchant WHERE id = ANY($1)", [merchantIds]);
  if (userId) {
    await q("DELETE FROM api_usage WHERE user_id = $1", [userId]);
    await q("DELETE FROM app_user WHERE id = $1", [userId]);
  }
  await client.end();
});

describe.skipIf(!CHROME)("sohbet blok düzeni v2 (gerçek Chrome)", () => {
  for (const viewport of [
    { name: "masaüstü", width: 1280, height: 900 },
    { name: "mobil", width: 390, height: 800 },
  ]) {
    it(`${viewport.name}: özet satırı, ilk 6 kart, 'Tüm N sonucu gör' ile 30'a kadar yerinde açılır`, async () => {
      const id = await oneSearchConversation();
      await page.setViewport({ width: viewport.width, height: viewport.height });
      await open(`/sohbet/${id}`);

      // Özet: gerçek veriden (40 üründen en fazla 30 gösterilir, 3 mağaza).
      const summary = await textOf("p[aria-label='Sonuç özeti']");
      expect(summary).toContain("3 mağazadan 30 ürün");

      // Karar 0201: ilk 4 kartın hemen altında modelsiz, olgusal değerlendirme (TL aralığı, mağaza).
      const commentary = await textOf("section[aria-label='Değerlendirme']");
      expect(commentary).toMatch(/TL/);
      expect(commentary).toMatch(/3 (farklı )?mağaza/);
      expect(commentary).not.toMatch(/ucuz|satın al|dupe/i);
      const headCount = await page.evaluate<number>(
        "document.querySelector(\"section[aria-label='Değerlendirme']\").previousElementSibling.querySelectorAll(':scope > li').length",
      );
      expect(headCount).toBe(4);

      // Karar 0201: sayfa açılışında alta kaydırılmış, "Yeni yanıt" düğmesi yok, klavye boşluğu 0.
      const scroll = await page.evaluate<{ dist: number; y: number; kb: string }>(
        "({ y: window.scrollY, dist: document.documentElement.scrollHeight - (window.scrollY + window.innerHeight), kb: getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim() })",
      );
      // Sayfa açılışında alta kaydırılır (içerik akıtıldıkça kalan boşluk kadar altta kalabilir).
      expect(scroll.dist <= 150 || scroll.y > 0).toBe(true);
      expect(["", "0px"]).toContain(scroll.kb);
      expect(
        await page.evaluate<boolean>(
          "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('Yeni yanıt'))",
        ),
      ).toBe(false);

      // Kademeli gösterim: ilk 6 kart + düğme, tüm sayı düğmede.
      expect(await cardCount()).toBe(6);
      const labelOf = () =>
        page.evaluate<string>(
          "[...document.querySelectorAll('button[aria-expanded]')].map((b) => b.textContent.trim()).join('|')",
        );
      expect(await labelOf()).toContain("Tüm 30 sonucu gör");

      // Düğme açınca aynı sayfada 30 kart; en fazla 30 (40 ürün olsa da).
      const before = await page.evaluate<string>("location.href");
      expect(await buttonByText("Tüm 30 sonucu gör")).toBe(true);
      await until(async () => (await cardCount()) === 30, "30 kart");
      expect(await page.evaluate<string>("location.href")).toBe(before); // sayfa değişmedi
      expect(await labelOf()).toContain("Daha az göster");
      expect(await cardCount()).toBeLessThanOrEqual(30);

      // Tekrar kapat.
      expect(await buttonByText("Daha az göster")).toBe(true);
      await until(async () => (await cardCount()) === 6, "6 karta dönüş");

      const noHScroll = await page.evaluate<boolean>(
        "document.documentElement.scrollWidth <= window.innerWidth + 1",
      );
      expect(noHScroll).toBe(true);
    });
  }

  it("eski blok varsayılan kapalı; 'Sonuçları göster' en çok 6 kart açar, tekrar kapatır, geçersiz sıra yok sayılır", async () => {
    const id = await twoSearchConversation();
    await page.setViewport({ width: 390, height: 800 });
    await open(`/sohbet/${id}`);

    // En yeni blok ürünsüz: sayfada hiç ürün kartı yok, eski blokta açma bağlantısı var.
    expect(await cardCount()).toBe(0);
    const toggleText = await page.evaluate<string>(
      "[...document.querySelectorAll('a')].map((a) => a.textContent.trim()).filter((t) => t.startsWith('Sonuçları')).join('|')",
    );
    expect(toggleText).toBe("Sonuçları göster");

    // Aç: ?ac=2, en çok 6 kart (30 değil), sekmeler/oy yok.
    const href = await page.evaluate<string>(
      "[...document.querySelectorAll('a')].find((a) => a.textContent.trim() === 'Sonuçları göster').getAttribute('href')",
    );
    expect(href).toContain("ac=2");
    await open(href);
    expect(await cardCount()).toBe(6);
    expect(
      await page.evaluate<boolean>(
        "[...document.querySelectorAll('a')].some((a) => a.textContent.trim() === 'Sonuçları gizle')",
      ),
    ).toBe(true);
    // Açılan eski blokta ek sekme satırı çizilmedi (compact).
    const tabs = await page.evaluate<number>(
      "document.querySelectorAll(\"nav[aria-label='Sonuç sıralaması']\").length",
    );
    expect(tabs).toBe(0);

    // Geçersiz/bilinmeyen sıra: yok sayılır, kart açılmaz.
    await open(`/sohbet/${id}?ac=3,999,abc`);
    expect(await cardCount()).toBe(0);
  });
});

/** Bayrak KAPALI sunucu (`E2E_UX_V2_OFF=1`, sunucuda CHAT_UX_V2 yok): bugünkü düzen aynen. */
describe.skipIf(!CHROME || process.env.E2E_UX_V2_OFF !== "1")(
  "sohbet blok düzeni: CHAT_UX_V2 kapalı (gerçek Chrome)",
  () => {
    it("özet satırı ve 'Tüm N sonucu gör' düğmesi yok; kartların hepsi (≤30) görünür; eski blokta açma bağlantısı yok", async () => {
      const id = await twoSearchConversation();
      await page.setViewport({ width: 1280, height: 900 });
      // En yeni blok ürünsüz; eski bloğu görmek için ürünlü sohbet ayrıca açılır.
      const single = await oneSearchConversation();
      await open(`/sohbet/${single}`);
      expect(await cardCount()).toBe(30);
      expect(await textOf("p[aria-label='Sonuç özeti']")).toBe("");
      expect(
        await page.evaluate<boolean>(
          "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('sonucu gör'))",
        ),
      ).toBe(false);
      await open(`/sohbet/${id}`);
      expect(
        await page.evaluate<boolean>(
          "[...document.querySelectorAll('a')].some((a) => a.textContent.trim().startsWith('Sonuçları'))",
        ),
      ).toBe(false);
      // ?ac= bayrak kapalıyken yok sayılır.
      await open(`/sohbet/${id}?ac=2`);
      expect(await cardCount()).toBe(0);
    });
  },
);
