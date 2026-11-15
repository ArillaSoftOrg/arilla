/**
 * Sohbet v2 sekmeler, iki ayrı geri bildirim ve alternatifler şeridi (karar 0202):
 * çalışan Next sunucusu + gerçek başsız Chrome (CDP). Yalnızca YEREL veritabanı ve sunucu;
 * model sahtedir. Sunucu `CHAT_DISCOVERY_ENABLED=true CHAT_UX_V2=true PRODUCT_ACCESS=open` ile
 * açılmalıdır.
 *
 *   E2E_BASE_URL=http://localhost:3335 DATABASE_URL_OWNER=<yerel> SESSION_SECRET=<aynı> \
 *     pnpm --filter @arilla/web test:e2e chat-tabs-feedback
 */
import {
  type ChatInterpreter,
  createConversation,
  generateRawToken,
  hashToken,
  processPendingTurn,
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
const TAG = `tfb${Date.now().toString(36)}`;
const db = createDatabase(requireLocal("DATABASE_URL_OWNER"));
const client = db.$client;
const PRODUCT_COUNT = 24;
const ALT_COUNT = 5;
const usage = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let userId = 0;
let browser: Browser | undefined;
let page: CdpPage;
let conversationId = "";
let merchantId = 0;
const productIds: number[] = [];
const altIds: number[] = [];

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}

async function addProduct(slug: string, title: string, price: number): Promise<number> {
  const product = await q<{ id: string }>(
    `INSERT INTO product (slug, title, min_price, primary_image_url, offer_count)
     VALUES ($1, $2, $3, $4, 1) RETURNING id`,
    [slug, title, price, `https://img.test/${slug}.jpg`],
  );
  const id = Number(product[0]?.id);
  await q(
    `INSERT INTO offer (merchant_id, product_id, external_id, url, title_raw, current_price, in_stock)
     VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
    [merchantId, id, `${slug}-o`, `https://${TAG}.test/${slug}`, title, price],
  );
  return id;
}

const interpreter: ChatInterpreter = {
  modelVersion: "e2e-fake",
  async interpret() {
    return {
      value: {
        action: "search",
        message: "Aşağıda arıyorum.",
        question: null,
        intent: { reset: false, clear: false, remove: [], query: `${TAG} lamba` },
      },
      usage,
      modelVersion: "e2e-fake",
    };
  },
};

/** Ürün bağlantılarının sayfadaki sırası (benzersiz, `/urun/<slug>`). */
const slugOrder = () =>
  page.evaluate<string[]>(
    `[...new Set([...document.querySelectorAll('a[href^="/urun/"]')].map((a) => a.getAttribute('href').replace('/urun/', '')))]`,
  );
const clickByLabel = (label: string) =>
  page.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === ${JSON.stringify(label)} || b.textContent.trim() === ${JSON.stringify(label)});
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
  const token = generateRawToken();
  await q(
    "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
    [userId, hashToken(token)],
  );
  const m = await q<{ id: string }>(
    `INSERT INTO merchant (slug, name, domain, source_type, trust_score)
     VALUES ($1, 'Test Mağaza', $2, 'xml_feed', 80) RETURNING id`,
    [`${TAG}-m`, `${TAG}.test`],
  );
  merchantId = Number(m[0]?.id);
  // Fiyatlar kasten KARIŞIK sırada eklenir: sıralama eklenme sırasından değil fiyattan gelmeli.
  for (let i = 0; i < PRODUCT_COUNT; i++) {
    const price = 10_000 + ((i * 7) % PRODUCT_COUNT) * 1_000; // 7 ile 24 aralarında asal: permütasyon
    productIds.push(await addProduct(`${TAG}-p${i}`, `${TAG} lamba modeli ${i}`, price));
  }
  // Alternatifler: sorguyla EŞLEŞMEYEN ürünler; hepsine kenar (similarity_edge) çekilir.
  for (let i = 0; i < ALT_COUNT; i++) {
    altIds.push(await addProduct(`${TAG}-a${i}`, `benzeroneri ${TAG} ${i}`, 90_000 + i));
  }
  for (const product of productIds) {
    for (const [i, alt] of altIds.entries()) {
      await q(
        "INSERT INTO similarity_edge (product_a, product_b, kind, score) VALUES ($1, $2, 'semantic', $3) ON CONFLICT DO NOTHING",
        [product, alt, 0.9 - i * 0.01],
      );
    }
  }
  const created = await createConversation(db, { userId, message: `${TAG} lamba` });
  if (created.status !== "created") throw new Error(created.status);
  conversationId = created.conversationId;
  const answered = await processPendingTurn(db, { userId, conversationId, interpreter });
  if (answered.status !== "answered") throw new Error(answered.status);
  browser = await Browser.launch(CHROME);
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setCookie(BASE, "session", token);
  await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
});

afterAll(async () => {
  await browser?.close();
  const all = [...productIds, ...altIds];
  if (all.length > 0) {
    await q("DELETE FROM similarity_edge WHERE product_a = ANY($1) OR product_b = ANY($1)", [all]);
    await q("DELETE FROM offer WHERE product_id = ANY($1)", [all]);
    await q("DELETE FROM product WHERE id = ANY($1)", [all]);
  }
  if (merchantId) await q("DELETE FROM merchant WHERE id = $1", [merchantId]);
  if (userId) {
    await q("DELETE FROM api_usage WHERE user_id = $1", [userId]);
    await q("DELETE FROM app_user WHERE id = $1", [userId]);
  }
  await client.end();
});

describe.skipIf(!CHROME)(
  "sohbet v2: sekmeler, geri bildirim, alternatifler (gerçek Chrome)",
  () => {
    it("sekmeler kullanıcının adlarıyla; 'En Uygun Fiyat' ilk kartları gerçekten en ucuzdan başlatır", async () => {
      await open(`/sohbet/${conversationId}`);
      const tabs = await page.evaluate<string>(
        "[...document.querySelectorAll(\"nav[aria-label='Sonuç sıralaması'] a, nav[aria-label='Sonuç sıralaması'] span\")].map((a) => a.textContent.trim()).join('|')",
      );
      expect(tabs).toBe("Önerilenler|En Uygun Fiyat|En İyi Eşleşmeler");
      // "En İyi Eşleşmeler" artık pasif değil (bağlantı).
      expect(
        await page.evaluate<boolean>(
          "[...document.querySelectorAll(\"nav[aria-label='Sonuç sıralaması'] a\")].some((a) => a.textContent.trim() === 'En İyi Eşleşmeler')",
        ),
      ).toBe(true);

      await open(`/sohbet/${conversationId}?sirala=firsat`);
      const cheapest = Array.from({ length: PRODUCT_COUNT }, (_, i) => ({
        slug: `${TAG}-p${i}`,
        price: 10_000 + ((i * 7) % PRODUCT_COUNT) * 1_000,
      })).sort((a, b) => a.price - b.price);
      const order = (await slugOrder()).filter((slug) => slug.startsWith(`${TAG}-p`));
      // İlk 4 kart: en ucuz 4 ürün, artan fiyatla; pahalı ürün üstte sabit KALMAZ.
      expect(order.slice(0, 4)).toEqual(cheapest.slice(0, 4).map((c) => c.slug));
      // Görünen tüm kartlarda fiyat monoton artan.
      const priceOf = new Map(cheapest.map((c) => [c.slug, c.price]));
      const prices = order.map((slug) => priceOf.get(slug) as number);
      expect(prices).toEqual([...prices].sort((a, b) => a - b));
    });

    it("'En İyi Eşleşmeler' hata vermez ve sekme ürün gösterir; sekmeler arası kartlar tekrar etmez", async () => {
      await open(`/sohbet/${conversationId}?sirala=eslesme`);
      const slugs = (await slugOrder()).filter((slug) => slug.startsWith(`${TAG}-p`));
      expect(slugs.length).toBeGreaterThan(0);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it("alternatifler şeridi: eşleşmeyen 5 benzer ürün, ana sonuçlarla karışmaz", async () => {
      await open(`/sohbet/${conversationId}`);
      const strip = await page.evaluate<string[]>(
        "[...document.querySelectorAll(\"section[aria-label='Benzer seçenekler'] a[href^='/urun/']\")].map((a) => a.getAttribute('href').replace('/urun/', ''))",
      );
      const unique = [...new Set(strip)];
      expect(unique.length).toBe(ALT_COUNT);
      expect(unique.every((slug) => slug.startsWith(`${TAG}-a`))).toBe(true);
      // Ana ürün listesinde alternatif yok.
      const main = (await slugOrder()).filter((slug) => slug.startsWith(`${TAG}-p`));
      expect(main.some((slug) => slug.startsWith(`${TAG}-a`))).toBe(false);
    });

    it("iki ayrı geri bildirim: açıklama ve ürün oyu bağımsız kaydedilir", async () => {
      await open(`/sohbet/${conversationId}`);
      const bodyText = await page.evaluate<string>("document.body.innerText");
      expect(bodyText).toContain("Bu değerlendirme yardımcı oldu mu?");
      expect(bodyText).toContain("Bu ürünler ihtiyacına uygun mu?");

      // Açıklama: Beğenmedim -> Yanlış bilgi
      expect(await clickByLabel("Beğenmedim")).toBe(true);
      await until(async () => {
        const rows = await q(
          "SELECT helpful FROM chat_explanation_feedback WHERE conversation_id = $1",
          [conversationId],
        );
        return rows.length === 1;
      }, "açıklama oyu yazıldı");
      expect(await clickByLabel("Yanlış bilgi")).toBe(true);
      await until(async () => {
        const rows = await q<{ reasons: string[] }>(
          "SELECT reasons FROM chat_explanation_feedback WHERE conversation_id = $1",
          [conversationId],
        );
        return rows[0]?.reasons?.[0] === "inaccurate";
      }, "neden yazıldı");

      // Ürün oyu: Evet, yardımcı oldu (👍), açıklama oyunu etkilemez.
      expect(await clickByLabel("Evet, yardımcı oldu")).toBe(true);
      await until(async () => {
        const rows = await q(
          "SELECT helpful FROM chat_result_feedback WHERE conversation_id = $1",
          [conversationId],
        );
        return rows.length === 1;
      }, "ürün oyu yazıldı");
      const explanation = await q<{ helpful: boolean; reasons: string[] }>(
        "SELECT helpful, reasons FROM chat_explanation_feedback WHERE conversation_id = $1",
        [conversationId],
      );
      const result = await q<{ helpful: boolean }>(
        "SELECT helpful FROM chat_result_feedback WHERE conversation_id = $1",
        [conversationId],
      );
      expect(explanation).toEqual([{ helpful: false, reasons: ["inaccurate"] }]);
      expect(result).toEqual([{ helpful: true }]);

      // Yenilemede iki oy da korunur (aria-pressed).
      await open(`/sohbet/${conversationId}`);
      const pressed = await page.evaluate<string>(
        "[...document.querySelectorAll('button[aria-pressed=\"true\"]')].map((b) => b.getAttribute('aria-label') ?? b.textContent.trim()).join('|')",
      );
      expect(pressed).toContain("Beğenmedim");
      expect(pressed).toContain("Evet, yardımcı oldu");
    });
  },
);
