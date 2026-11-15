/**
 * "Bu aramaya dön" (karar 0199): çalışan bir Next sunucusu + gerçek başsız Chrome (CDP).
 * Yalnızca YEREL veritabanı ve sunucu. Model sahtedir (betikli); gerçek Gemini çağrılmaz.
 *
 *   E2E_BASE_URL=http://localhost:3331 DATABASE_URL_OWNER=<yerel> \
 *     pnpm --filter @arilla/web test:e2e chat-restore-search
 *
 * Sunucu `CHAT_DISCOVERY_ENABLED=true PRODUCT_ACCESS=open` ile açılmalıdır.
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
const TAG = `rst${Date.now().toString(36)}`;
const db = createDatabase(requireLocal("DATABASE_URL_OWNER"));
const client = db.$client;

const RESTORE_LABEL = "Bu aramaya dön";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const usage = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };

let userId = 0;
let conversationId = "";
let browser: Browser | undefined;
let page: CdpPage;
let token = "";

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

async function seedConversation(): Promise<string> {
  const created = await createConversation(db, {
    userId,
    message: `${TAG} samsung telefon 15.000 TL altı`,
  });
  if (created.status !== "created") throw new Error(`sohbet oluşmadı: ${created.status}`);
  const id = created.conversationId;
  const first = await processPendingTurn(db, {
    userId,
    conversationId: id,
    interpreter: scripted({
      query: `${TAG} samsung telefon`,
      brand: "Samsung",
      priceMax: 15000,
    }),
  });
  if (first.status !== "answered") throw new Error(`ilk tur: ${first.status}`);
  const sent = await submitUserMessage(db, {
    userId,
    conversationId: id,
    request: { kind: "text", text: `${TAG} masa lambası` },
  });
  if (sent.status !== "queued") throw new Error(`ikinci mesaj: ${sent.status}`);
  const second = await processPendingTurn(db, {
    userId,
    conversationId: id,
    interpreter: scripted({ reset: true, query: `${TAG} masa lambası` }),
  });
  if (second.status !== "answered") throw new Error(`ikinci tur: ${second.status}`);
  return id;
}

const messages = (id: string) =>
  q<{ seq: number; role: string; kind: string; content: string; payload: unknown }>(
    "SELECT seq, role, kind, content, payload FROM chat_message WHERE conversation_id = $1 ORDER BY seq",
    [id],
  );

const buttonCount = () =>
  page.evaluate<number>(
    `[...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === ${JSON.stringify(RESTORE_LABEL)}).length`,
  );
const clickRestore = () =>
  page.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(RESTORE_LABEL)});
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
  const tail = await page.evaluate<string>("document.body.innerText.slice(-400)");
  throw new Error(`zaman aşımı: ${what} :: ${tail}`);
}
async function openChat(): Promise<void> {
  await page.goto(`${BASE}/sohbet/${conversationId}`);
  await wait(3000); // hidrasyon
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
  browser = await Browser.launch(CHROME);
  page = await browser.newPage();
  await page.setCookie(BASE, "session", token);
  await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
});

afterAll(async () => {
  await browser?.close();
  if (userId) {
    await q("DELETE FROM api_usage WHERE user_id = $1", [userId]);
    await q("DELETE FROM app_user WHERE id = $1", [userId]);
  }
  await client.end();
});

describe.skipIf(!CHROME)("Bu aramaya dön (gerçek Chrome)", () => {
  for (const viewport of [
    { name: "masaüstü", width: 1280, height: 900 },
    { name: "mobil", width: 390, height: 800 },
  ]) {
    it(`${viewport.name}: eski blokta düğme var, tıklayınca önceki arama yeni tur olur, eski mesajlar korunur`, async () => {
      conversationId = await seedConversation();
      await page.setViewport({ width: viewport.width, height: viewport.height });
      const before = await messages(conversationId);
      expect(before.map((m) => m.seq)).toEqual([1, 2, 3, 4]);

      await openChat();
      // Yalnız ESKİ (telefon) blokta düğme; son (lamba) blokta yok.
      expect(await buttonCount()).toBe(1);
      // Düğme görünümde, yatayda taşmıyor.
      const rect = await page.evaluate<{ left: number; right: number; w: number }>(`(() => {
        const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(RESTORE_LABEL)});
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, w: window.innerWidth };
      })()`);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(rect.w);
      const noHScroll = await page.evaluate<boolean>(
        "document.documentElement.scrollWidth <= window.innerWidth + 1",
      );
      expect(noHScroll).toBe(true);

      // Çift tıklama: aynı bileşen anahtarı, yalnız bir tur yazılmalı.
      await clickRestore();
      await clickRestore();
      await until(async () => (await messages(conversationId)).length >= 6, "yeni tur yazıldı");
      await wait(1500);

      const after = await messages(conversationId);
      expect(after.length).toBe(6); // yalnız +2
      expect(after.slice(0, 4)).toEqual(before); // eski mesajlar birebir
      expect(after[4]).toMatchObject({ role: "user", kind: "text" });
      expect(after[4]?.content).toContain("samsung telefon");
      expect(after[5]).toMatchObject({ role: "assistant", kind: "search" });

      const conv = await q<{
        current_search_intent: { query: string; brand: string; priceMax: number };
      }>("SELECT current_search_intent FROM conversation WHERE id = $1", [conversationId]);
      expect(conv[0]?.current_search_intent).toMatchObject({
        query: `${TAG} samsung telefon`,
        brand: "Samsung",
        priceMax: 15000,
      });

      // Sayfa yeni durumu gösteriyor: yeni asistan metni + eski mesajlar hâlâ okunur.
      await until(
        async () =>
          page.evaluate<boolean>(
            "document.body.innerText.includes('Önceki aramana döndüm') && document.body.innerText.includes('Marka: Samsung')",
          ),
        "yeni tur ekranda",
      );
      const body = await page.evaluate<string>("document.body.innerText");
      expect(body).toContain(`${TAG} masa lambası`); // eski kullanıcı mesajı korunuyor
      // Şimdi lamba bloğu eskide kaldı: tek düğme (onda), telefon bloğunda artık yok.
      await until(async () => (await buttonCount()) === 1, "tek düğme");
    });
  }

  it("başka kullanıcının sohbetine geri dönüş isteği düşer (yetkisiz)", async () => {
    const other = await q<{ id: string }>(
      "INSERT INTO app_user (email, role) VALUES ($1, 'user') RETURNING id",
      [`${TAG}-other@test.local`],
    );
    const otherId = Number(other[0]?.id);
    try {
      const id = await seedConversation();
      const before = await messages(id);
      const { restoreSearch } = await import("@arilla/core");
      const result = await restoreSearch(db, {
        userId: otherId,
        conversationId: id,
        messageSeq: 2,
        requestKey: `${TAG}-foreign-key`,
      });
      expect(result).toEqual({ status: "not_found" });
      expect(await messages(id)).toEqual(before);
    } finally {
      await q("DELETE FROM app_user WHERE id = $1", [otherId]);
    }
  });
});
