/**
 * Yönetim arayüzü duyarlılık ve erişilebilirlik regresyonu (karar 0083, Faz
 * B.1): çalışan bir `next start`'a gerçek başsız Chrome ile (CDP, `cdp.ts`).
 * Güvenlik başlıkları olduğu gibi kalır; ekran boyutu, dokunmatik ve tema
 * tarayıcı öykünmesiyle verilir. Chrome bulunamazsa test atlanır.
 *
 *   E2E_BASE_URL=http://127.0.0.1:3312 SESSION_SECRET=<sunucuyla aynı> \
 *     pnpm --filter @arilla/web test:e2e
 *
 * Denetlenenler: 360/390/768/1024/1440px'te belge yatay taşmıyor; 1024 altında
 * yan menü gizli ve "Menü" düğmesi görünür (üstünde tersi); çekmece odak
 * tuzağı, Esc, odağın düğmeye dönmesi ve kaydırma kilidi; çekmecede menü
 * açıklamaları görünür; dokunmatikte kontroller ≥ 44px, bağlantılar ≥ 24px;
 * iki temada metin kontrastı WCAG AA.
 */
import { readdirSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { generateRawToken, hashToken } from "@arilla/core";
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
const TAG = `resp${Date.now().toString(36)}`;
const WIDTHS = [360, 390, 768, 1024, 1440] as const;

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;
const owner = () => {
  ownerPool ??= createDatabase(requireLocal("DATABASE_URL_OWNER")).$client;
  return ownerPool;
};

const fixture = {
  inboxId: 0,
  adminId: 0,
  adminPublicId: "",
  token: "",
  merchantSlug: `${TAG}-magaza`,
  productId: 0,
  formId: 0,
  campaignPublicId: "",
  feedbackMessageId: 0,
};
let browser: Browser | undefined;
let page: CdpPage;

function pages(): string[] {
  return [
    "/yonetim",
    "/yonetim/magazalar",
    `/yonetim/magazalar/${fixture.merchantSlug}`,
    "/yonetim/ingest",
    "/yonetim/katalog/urunler",
    `/yonetim/katalog/urunler/${fixture.productId}`,
    "/yonetim/katalog/teklifler",
    "/yonetim/katalog/kalite",
    "/yonetim/eslestirme",
    "/yonetim/eslestirme/gecmis",
    "/yonetim/arama/tani",
    "/yonetim/sozluk",
    "/yonetim/arama/gorsel",
    "/yonetim/arama/link",
    "/yonetim/ai-geri-bildirim",
    `/yonetim/ai-geri-bildirim/${fixture.feedbackMessageId}`,
    "/yonetim/kullanicilar",
    `/yonetim/kullanicilar/${fixture.adminPublicId}`,
    "/yonetim/erken-erisim",
    "/yonetim/mesajlar",
    "/yonetim/formlar",
    "/yonetim/formlar/yeni",
    `/yonetim/formlar/${fixture.formId}`,
    `/yonetim/formlar/${fixture.formId}/sonuclar`,
    "/yonetim/kampanyalar",
    `/yonetim/kampanyalar/${fixture.campaignPublicId}`,
    "/yonetim/seo",
    "/yonetim/islemler",
    "/yonetim/islemler/isler",
    "/yonetim/denetim",
    "/yonetim/ai",
    "/yonetim/ai?gun=30",
    "/yonetim/yolculuk",
    "/yonetim/affiliate",
    "/yonetim/affiliate?durum=active",
    // Karar 0086
    "/yonetim/trendler",
    "/yonetim/trendler?durum=draft",
    "/yonetim/mesajlar?durum=new",
    "/yonetim/ayarlar",
    // Karar 0087 (GA4 yapılandırılmamışsa "bağlı değil" durumu çizilir)
    "/yonetim/trafik",
    "/yonetim/trafik?gun=90&dilim=hafta&olcu=sessions",
  ];
}

beforeAll(async () => {
  if (!CHROME) return;
  const db = owner();
  const user = await db.query(
    "INSERT INTO app_user (email, role) VALUES ($1, 'admin') RETURNING id, public_id",
    [`${TAG}-admin@test.local`],
  );
  fixture.adminId = Number(user.rows[0].id);
  fixture.adminPublicId = String(user.rows[0].public_id);
  fixture.token = generateRawToken();
  await db.query(
    "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '2 hours')",
    [fixture.adminId, hashToken(fixture.token)],
  );
  await db.query(
    `INSERT INTO merchant (slug, name, domain, source_type, is_active)
     VALUES ($1, 'Duyarlılık Mağazası', $2, 'xml_feed', TRUE)`,
    [fixture.merchantSlug, `${TAG}.test`],
  );
  const product = await db.query(
    "INSERT INTO product (slug, title) VALUES ($1, 'Duyarlılık ürünü') RETURNING id",
    [`${TAG}-urun`],
  );
  fixture.productId = Number(product.rows[0].id);
  const form = await db.query(
    "INSERT INTO form (slug, title) VALUES ($1, 'Duyarlılık formu') RETURNING id",
    [`${TAG}-form`],
  );
  fixture.formId = Number(form.rows[0].id);
  const campaign = await db.query(
    `INSERT INTO marketing_campaign (title, subject, body)
     VALUES ($1, 'Konu', 'Gövde') RETURNING public_id`,
    [`${TAG} kampanya`],
  );
  fixture.campaignPublicId = String(campaign.rows[0].public_id);
  // AI geri bildirim ayrıntısı için: sohbet + yanıt + oy (hesap silinince CASCADE).
  const conversation = await db.query(
    "INSERT INTO conversation (user_id, title) VALUES ($1, 'Duyarlılık sohbeti') RETURNING id",
    [fixture.adminId],
  );
  const message = await db.query(
    `INSERT INTO chat_message (conversation_id, seq, role, kind, content)
     VALUES ($1, 1, 'assistant', 'notice', 'Duyarlılık yanıtı') RETURNING id`,
    [conversation.rows[0].id],
  );
  fixture.feedbackMessageId = Number(message.rows[0].id);
  await db.query(
    "INSERT INTO chat_result_feedback (message_id, conversation_id, helpful) VALUES ($1, $2, TRUE)",
    [fixture.feedbackMessageId, conversation.rows[0].id],
  );

  // Karar 0086: taslak trend (public'i etkilemez, sıranın sonunda) ve triyaj için mesaj.
  await db.query(
    `INSERT INTO trend (slug, title, description, category, status, sort_order)
     VALUES ($1, 'Duyarlılık trendi', 'Duyarlılık açıklaması', 'genel', 'draft', 2000000000)`,
    [`${TAG}-trend`],
  );
  const inboxRow = await db.query(
    `INSERT INTO feedback (kind, category, title, message, source)
     VALUES ('feedback', 'other', 'Duyarlılık mesajı', 'Duyarlılık gövdesi', 'public') RETURNING id`,
  );
  fixture.inboxId = Number(inboxRow.rows[0].id);

  browser = await Browser.launch(CHROME);
  page = await browser.newPage();
  await page.setCookie(BASE, "session", fixture.token);
  // Çerez bandı yerleşimi örtmesin: zorunlu dışı her şey reddedilmiş rıza.
  await page.setCookie(BASE, "cookie_consent", encodeURIComponent(serializeConsent(rejectAll())));
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (!CHROME) return;
  const db = owner();
  await db.query(
    `DELETE FROM admin_audit_event
      WHERE actor_user_id = $1 OR (target_type = 'app_user' AND target_id = $2)`,
    [fixture.adminId, String(fixture.adminId)],
  );
  await db.query("DELETE FROM marketing_campaign WHERE public_id = $1", [fixture.campaignPublicId]);
  await db.query("DELETE FROM trend WHERE slug = $1", [`${TAG}-trend`]);
  await db.query("DELETE FROM feedback WHERE id = $1", [fixture.inboxId]);
  await db.query("DELETE FROM form WHERE id = $1", [fixture.formId]);
  await db.query("DELETE FROM product WHERE id = $1", [fixture.productId]);
  await db.query("DELETE FROM merchant WHERE slug = $1", [fixture.merchantSlug]);
  await db.query("DELETE FROM app_user WHERE id = $1", [fixture.adminId]);
  await ownerPool?.end();
});

const LAYOUT_PROBE = `(() => {
  const vw = document.documentElement.clientWidth;
  const shown = (sel) => { const el = document.querySelector(sel); return !!el && getComputedStyle(el).display !== "none" && el.getBoundingClientRect().width > 0; };
  return {
    path: location.pathname,
    overflow: document.documentElement.scrollWidth - vw,
    sidebar: shown("aside"),
    menuButton: shown("header button[aria-haspopup=dialog]"),
    breadcrumbs: shown("header nav[aria-label=Konum]"),
  };
})()`;

/** Dokunmatikte küçük hedefler: kontrol < 44px, satır içi olmayan bağlantı < 24px. */
const TARGET_PROBE = `(() => {
  const small = [];
  for (const el of document.querySelectorAll("main a, main button, main select, main input:not([type=hidden]), main textarea, main summary, header button")) {
    const s = getComputedStyle(el); const r0 = el.getBoundingClientRect();
    if (r0.width === 0 || s.visibility === "hidden" || el.closest("dialog:not([open])")) continue;
    let target = el;
    if ((el.type === "checkbox" || el.type === "radio") && el.closest("label")) target = el.closest("label");
    const r = target.getBoundingClientRect();
    const isLink = el.tagName === "A";
    if (isLink && el.closest("p, dd") && s.display === "inline") continue;
    if (r.height < (isLink ? 24 : 44)) small.push(el.tagName + " «" + (el.innerText || el.value || "").trim().slice(0, 24) + "» " + Math.round(r.height));
  }
  return small.slice(0, 5);
})()`;

const CONTRAST_PROBE = `(() => {
  const lum = (c) => { const srgb = c.startsWith("color(srgb"); const m = c.replace(/^color\\(srgb/, "").match(/[\\d.]+/g).map(Number); if (srgb) { for (let i = 0; i < 3; i++) m[i] *= 255; } const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] ?? 1 }; };
  const bgOf = (el) => { for (let p = el; p; p = p.parentElement) { const c = getComputedStyle(p).backgroundColor; if (lum(c).a > 0.9) return c; } return getComputedStyle(document.body).backgroundColor; };
  const low = [];
  for (const el of document.querySelectorAll("main *, header *, aside *")) {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    if (r.width === 0 || s.visibility === "hidden" || el.closest("[disabled]")) continue;
    if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
    if (lum(s.color).a < 0.9) continue;
    const a = lum(s.color).L, b = lum(bgOf(el)).L;
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const large = parseFloat(s.fontSize) >= 24;
    if (ratio < (large ? 3 : 4.5)) low.push((el.innerText || "").trim().slice(0, 24) + " " + ratio.toFixed(2));
  }
  return low.slice(0, 5);
})()`;

describe("sayfa listesi eksiksiz (karar 0085)", () => {
  it("yönetimdeki her page.tsx bu testin sayfa listesinde", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../app/yonetim");
    const routes: string[] = [];
    const walk = (abs: string) => {
      for (const name of readdirSync(abs)) {
        const path = join(abs, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name === "page.tsx") {
          const rel = relative(dir, dirname(path)).split(sep).join("/");
          routes.push(rel === "" ? "/yonetim" : `/yonetim/${rel}`);
        }
      }
    };
    walk(dir);
    // Fikstür değerleri rota parametresine geri çevrilir; sorgu dizisi atılır.
    const listed = new Set(
      pages().map((path) =>
        (path.split("?")[0] as string)
          .replace(`/magazalar/${fixture.merchantSlug}`, "/magazalar/[slug]")
          .replace(/\/katalog\/urunler\/[^/]+$/, "/katalog/urunler/[id]")
          .replace(/\/kullanicilar\/[^/]+$/, "/kullanicilar/[publicId]")
          .replace(/\/formlar\/(?!yeni)[^/]+/, "/formlar/[id]")
          .replace(/\/kampanyalar\/[^/]+$/, "/kampanyalar/[publicId]")
          .replace(/\/ai-geri-bildirim\/[^/]+$/, "/ai-geri-bildirim/[messageId]"),
      ),
    );
    expect(routes.filter((route) => !listed.has(route)).sort()).toEqual([]);
  });
});

describe.skipIf(!CHROME)("yönetim arayüzü - duyarlılık (gerçek Chrome)", () => {
  for (const width of WIDTHS) {
    it(`${width}px: hiçbir sayfa yatay taşmaz; menü kırılımı doğru`, async () => {
      const touch = width < 1024;
      await page.setColorScheme("light");
      await page.setViewport({ width, height: 800, touch });
      const problems: string[] = [];
      for (const path of pages()) {
        await page.goto(BASE + path);
        const probe = await page.evaluate<{
          path: string;
          overflow: number;
          sidebar: boolean;
          menuButton: boolean;
          breadcrumbs: boolean;
        }>(LAYOUT_PROBE);
        // Yetkili oturumla sayfa açılmalı (girişe yönlenmemeli).
        if (!probe.path.startsWith(path.split("?")[0] as string)) {
          problems.push(`${path}: ${probe.path} adresine gitti`);
          continue;
        }
        if (probe.overflow > 0) problems.push(`${path}: ${probe.overflow}px yatay taşma`);
        if (probe.sidebar === touch)
          problems.push(`${path}: yan menü ${probe.sidebar ? "görünür" : "gizli"}`);
        if (probe.menuButton !== touch) problems.push(`${path}: Menü düğmesi yanlış`);
        if (touch && probe.breadcrumbs) problems.push(`${path}: konum yolu dar ekranda görünür`);
      }
      expect(problems).toEqual([]);
    }, 180_000);
  }

  it("390px dokunmatik: kontroller ≥ 44px, bağlantılar ≥ 24px", async () => {
    await page.setViewport({ width: 390, height: 800, touch: true });
    const problems: string[] = [];
    for (const path of pages()) {
      await page.goto(BASE + path);
      const small = await page.evaluate<string[]>(TARGET_PROBE);
      if (small.length > 0) problems.push(`${path}: ${small.join(", ")}`);
    }
    expect(problems).toEqual([]);
  }, 180_000);

  it("çekmece: açılır, odak içeride kalır, Esc kapatır, odak düğmeye döner, açıklamalar görünür", async () => {
    await page.setViewport({ width: 390, height: 800, touch: true });
    await page.goto(`${BASE}/yonetim/magazalar`);
    await page.click("header button[aria-haspopup=dialog]");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const opened = await page.evaluate<{
      open: boolean;
      focusInside: boolean;
      locked: string;
      expanded: string | null;
      descriptions: number;
    }>(`(() => {
      const dlg = document.querySelector("dialog[open]");
      return {
        open: !!dlg,
        focusInside: !!document.activeElement?.closest("dialog[open]"),
        locked: document.documentElement.style.overflow,
        expanded: document.querySelector("header button[aria-haspopup=dialog]").getAttribute("aria-expanded"),
        descriptions: dlg ? [...dlg.querySelectorAll("a span span:nth-child(2)")].filter((s) => s.getBoundingClientRect().height > 1).length : 0,
      };
    })()`);
    expect(opened).toMatchObject({
      open: true,
      focusInside: true,
      locked: "hidden",
      expanded: "true",
    });
    // Yalnızca etkin grup (Katalog, 7 öğe) ve Genel bakış açık (karar 0084).
    expect(opened.descriptions).toBeGreaterThanOrEqual(5);

    for (let i = 0; i < 60; i++) await page.press("Tab");
    expect(await page.evaluate<boolean>("!!document.activeElement?.closest('dialog[open]')")).toBe(
      true,
    );

    await page.press("Escape");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const closed = await page.evaluate<{ open: boolean; focus: string; locked: string }>(`({
      open: !!document.querySelector("dialog[open]"),
      focus: document.activeElement?.textContent?.trim() ?? "",
      locked: document.documentElement.style.overflow,
    })`);
    expect(closed).toEqual({ open: false, focus: "Menü", locked: "" });
  }, 60_000);

  it("masaüstü: yalnızca etkin grup açık, diğerleri elle açılır; açıklama ekran okuyucuya açık", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/yonetim/magazalar`);
    const nav = await page.evaluate<{
      described: boolean;
      hidden: boolean;
      activeGroupOpen: boolean;
      otherOpen: number;
      groups: number;
    }>(`(() => {
      const link = document.querySelector("aside a[aria-current=page]");
      const desc = link.querySelector("span span:nth-child(2)");
      const groups = [...document.querySelectorAll("aside details")];
      return {
        described: (link.textContent ?? "").includes("feed"),
        hidden: desc.getBoundingClientRect().height <= 1,
        activeGroupOpen: link.closest("details").open,
        otherOpen: groups.filter((g) => g.open && !g.contains(link)).length,
        groups: groups.length,
      };
    })()`);
    expect(nav).toMatchObject({
      described: true,
      hidden: true,
      activeGroupOpen: true,
      otherOpen: 0,
    });
    expect(nav.groups).toBeGreaterThan(3);
    // Kapalı bir grup gerçek tıklamayla açılır.
    await page.click("aside details:not([open]) summary");
    const opened = await page.evaluate<number>(
      `[...document.querySelectorAll("aside details")].filter((g) => g.open).length`,
    );
    expect(opened).toBe(2);
  }, 60_000);

  it("genel bakış: uyarılar kısa satır; her birinin ayrıntısında önerilen adım var", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/yonetim`);
    const alerts = await page.evaluate<{
      items: number;
      withAction: number;
      kpis: number;
    }>(`(() => {
      const panel = document.getElementById("simdi-dikkat").closest("section");
      const items = [...panel.querySelectorAll("li")];
      return {
        items: items.length,
        withAction: items.filter((li) => li.querySelector("details")?.textContent?.includes("Ne yapmalı:")).length,
        kpis: document.querySelector("[aria-labelledby=gostergeler] div").children.length,
      };
    })()`);
    expect(alerts.withAction).toBe(alerts.items);
    expect(alerts.kpis).toBe(12);
  }, 60_000);

  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme} tema: tema belirteçleri uygulanır, metin kontrastı WCAG AA`, async () => {
      await page.setColorScheme(scheme);
      await page.setViewport({ width: 1440, height: 900 });
      const problems: string[] = [];
      let background = "";
      for (const path of [
        "/yonetim",
        "/yonetim/magazalar",
        "/yonetim/islemler",
        "/yonetim/sozluk",
        "/yonetim/denetim",
      ]) {
        await page.goto(BASE + path);
        background = await page.evaluate<string>(
          "getComputedStyle(document.querySelector('main').parentElement.parentElement).backgroundColor",
        );
        const low = await page.evaluate<string[]>(CONTRAST_PROBE);
        if (low.length > 0) problems.push(`${path}: ${low.join(", ")}`);
      }
      // Kanvas --surface: açıkta açık, koyuda koyu (tema gerçekten değişiyor).
      const channels = background.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
      const average = channels.reduce((sum, n) => sum + n, 0) / Math.max(channels.length, 1);
      expect(scheme === "light" ? average > 200 : average < 60).toBe(true);
      expect(problems).toEqual([]);
    }, 120_000);
  }
});
