/**
 * Sohbet fotografi icin acik riza (karar 0101): `next start` + gercek basisiz Chrome (CDP).
 * Yalnizca YEREL veritabani ve sunucu. Model anahtari tanimsiz oldugundan Gemini adimi
 * hata ile biter; bu testin kapsami riza, yukleme, saklama, gecmis ve hata gosterimidir
 * (gercek Gemini cevabi DEGIL).
 *
 *   E2E_BASE_URL=http://localhost:3320 CHROME_PATH=<chrome> \
 *     pnpm --filter @arilla/web test:e2e chat-image-consent
 *
 * Sunucu `CHAT_DISCOVERY_ENABLED=true CHAT_IMAGE_ENABLED=true PRODUCT_ACCESS=open` ile acilmalidir.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";
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
const TAG = `imgc${Date.now().toString(36)}`;
const db = createDatabase(requireLocal("DATABASE_URL_OWNER"));
const client = db.$client;

const ACCEPT_LABEL = "Fotoğrafımın bu şekilde kullanılmasını kabul ediyorum";
const DECLINE_LABEL = "Kabul etmiyorum";
const WITHDRAW_LABEL = "İznimi geri çek";

/** 96x96 duz renkli, gecerli PNG (bagimlilik yok). */
function makePng(): Buffer {
  const w = 96;
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * w);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = 200;
      raw[o + 1] = 40 + (x % 50);
      raw[o + 2] = 90;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(w, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let dir = "";
let png = "";
let userId = 0;
let conversationId = "";
let browser: Browser | undefined;
let page: CdpPage;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(sql, params)).rows as T[];
}
const consentRows = () =>
  q<{ granted: boolean }>(
    "SELECT granted FROM user_consent WHERE user_id = $1 AND kind = 'chat_image' ORDER BY id",
    [userId],
  );
async function attachmentCount(): Promise<number> {
  const rows = await q<{ n: string }>(
    "SELECT count(*) AS n FROM chat_attachment WHERE user_id = $1",
    [userId],
  );
  return Number(rows[0]?.n);
}
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await wait(150);
  }
  const state = await page.evaluate<string>(
    "JSON.stringify({open: document.querySelectorAll('dialog[open]').length, dialogs: document.querySelectorAll('dialog').length, url: location.href, files: document.querySelector('input[type=file]')?.files?.length, alert: document.querySelector('[role=alert]')?.innerText, tail: document.body.innerText.slice(-300)})",
  );
  throw new Error(`zaman aşımı: ${what} ${state}`);
}
/** Sayfa yuklenir, React'in hidrasyonu (olay dinleyicileri) icin kisa bir sure taninir. */
async function openChat(): Promise<void> {
  await page.goto(`${BASE}/sohbet/${conversationId}`);
  await wait(2500);
}
const dialogOpen = () => page.evaluate<boolean>("Boolean(document.querySelector('dialog[open]'))");
const hasPreview = () =>
  page.evaluate<boolean>("Boolean(document.querySelector('img[src^=\"blob:\"]'))");
const clickByText = (text: string) =>
  page.evaluate<boolean>(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === ${JSON.stringify(text)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

async function answeredConversation(): Promise<string> {
  const created = await createConversation(db, { userId, message: "siyah ceket" });
  if (created.status !== "created") throw new Error(`sohbet oluşmadı: ${created.status}`);
  const id = created.conversationId;
  // Ilk tur sahte modelle cevaplanir: composer yalnizca cevaplanmis sohbette acik olur.
  const usage = { inputTokens: 5, outputTokens: 5, thoughtTokens: 0, totalTokens: 10 };
  const interpreter: ChatInterpreter = {
    modelVersion: "e2e-fake",
    async interpret() {
      return {
        value: {
          action: "search",
          message: "Benzerlerini aşağıda açtım.",
          question: null,
          intent: { reset: false, clear: false, remove: [], query: "siyah ceket" },
        },
        usage,
        modelVersion: "e2e-fake",
      };
    },
  };
  const answered = await processPendingTurn(db, { userId, conversationId: id, interpreter });
  if (answered.status !== "answered") throw new Error(`ilk tur cevaplanmadı: ${answered.status}`);
  return id;
}

beforeAll(async () => {
  if (!CHROME) return;
  dir = mkdtempSync(join(tmpdir(), "arilla-imgc-"));
  png = join(dir, "urun.png");
  writeFileSync(png, makePng());
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
  conversationId = await answeredConversation();
  browser = await Browser.launch(CHROME);
  page = await browser.newPage();
  await page.setViewport({ width: 1024, height: 800 });
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
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!CHROME)("sohbet fotoğrafı: açık rıza akışı (gerçek Chrome)", () => {
  it("rıza yokken dosya seçmek bilgilendirme penceresini açar; hiçbir şey kaydedilmez", async () => {
    await openChat();
    expect(
      await page.evaluate<boolean>("Boolean(document.querySelector('input[type=file]'))"),
    ).toBe(true);
    await page.setFileInput("input[type=file]", png);
    await until(dialogOpen, "rıza penceresi");
    const text = await page.evaluate<string>("document.querySelector('dialog[open]').innerText");
    expect(text).toContain("Gemini");
    expect(text).toContain("90 gün");
    expect(
      await page.evaluate<number>(
        "document.querySelectorAll('dialog[open] input[type=checkbox]').length",
      ),
    ).toBe(0);
    expect(await hasPreview()).toBe(false);
    expect(await consentRows()).toHaveLength(0);
    expect(await attachmentCount()).toBe(0);
  });

  it("Kabul etmiyorum: pencere kapanır, fotoğraf eklenmez, rıza satırı yazılmaz", async () => {
    expect(await clickByText(DECLINE_LABEL)).toBe(true);
    await until(async () => !(await dialogOpen()), "pencere kapanışı");
    expect(await hasPreview()).toBe(false);
    expect(await consentRows()).toHaveLength(0);
  });

  it("Esc de ret sayılır (kabul değil)", async () => {
    await openChat();
    await page.setFileInput("input[type=file]", png);
    await until(dialogOpen, "rıza penceresi");
    await page.press("Escape");
    await until(async () => !(await dialogOpen()), "Esc kapanışı");
    expect(await hasPreview()).toBe(false);
    expect(await consentRows()).toHaveLength(0);
  });

  it("kabul: rıza kaydedilir, fotoğraf önizlemede görünür, henüz sunucuya gitmemiştir", async () => {
    await openChat();
    await page.setFileInput("input[type=file]", png);
    await until(dialogOpen, "rıza penceresi");
    expect(await clickByText(ACCEPT_LABEL)).toBe(true);
    await until(hasPreview, "önizleme");
    const rows = await consentRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.granted).toBe(true);
    expect(await attachmentCount()).toBe(0);
    const stored = await q<{ source: string; text_version: string; ip: string | null }>(
      "SELECT source, text_version, ip FROM user_consent WHERE user_id = $1 AND kind = 'chat_image'",
      [userId],
    );
    expect(stored[0]).toMatchObject({ source: "chat_image_prompt", ip: null });
    expect(stored[0]?.text_version).toMatch(/^chat-image-/);
  });

  it("görsel-only gönderim: ek saklanır, geçmişte görünür, yalnız sahibine sunulur", async () => {
    await page.evaluate(
      "document.querySelector('textarea').form.querySelector('button[type=submit]').click()",
    );
    await until(async () => (await attachmentCount()) === 1, "ek kaydı");
    await until(
      () =>
        page.evaluate<boolean>("Boolean(document.querySelector('img[src*=\"/sohbet/gorsel/\"]'))"),
      "geçmişte görsel",
    );
    const src = await page.evaluate<string>(
      "document.querySelector('img[src*=\"/sohbet/gorsel/\"]').getAttribute('src')",
    );
    const own = await page.evaluate<{ status: number; type: string | null }>(
      `fetch(${JSON.stringify(src)}).then((r) => ({ status: r.status, type: r.headers.get('content-type') }))`,
    );
    expect(own.status).toBe(200);
    expect(own.type).toMatch(/^image\/(png|jpeg)$/);
    expect((await fetch(`${BASE}${src}`)).status).toBe(404);
  });

  it("model anahtarı yokken tur hatası anlaşılır gösterilir (ham hata sızmaz)", async () => {
    await until(
      () => page.evaluate<boolean>("Boolean(document.querySelector('[role=alert]'))"),
      "hata bildirimi",
      30_000,
    );
    const alertText = await page.evaluate<string>(
      "document.querySelector('[role=alert]').innerText",
    );
    expect(alertText.length).toBeGreaterThan(5);
    expect(alertText).not.toMatch(/missing_api_key|GEMINI|stack|Error:/);
  });

  it("hesap sayfasından geri çekme çalışır; sonraki dosya seçiminde yeniden sorulur", async () => {
    await page.goto(`${BASE}/hesap/gizlilik`);
    expect(await clickByText(WITHDRAW_LABEL)).toBe(true);
    await until(async () => (await consentRows()).length === 2, "geri çekme kaydı");
    expect((await consentRows())[1]?.granted).toBe(false);
    // Onceki turdaki cevapsiz mesaj composer'i kilitler: temiz, cevaplanmis bir sohbet.
    conversationId = await answeredConversation();
    await openChat();
    await page.setFileInput("input[type=file]", png);
    await until(dialogOpen, "yeniden rıza penceresi");
  });
});
