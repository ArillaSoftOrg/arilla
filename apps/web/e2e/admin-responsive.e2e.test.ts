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
  adminId: 0,
  adminPublicId: "",
  token: "",
  merchantSlug: `${TAG}-magaza`,
  productId: 0,
  formId: 0,
  campaignPublicId: "",
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
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return { L: 0.2126 * r + 0.7152 * g + 0.0722 * b, a: m[3] ?? 1 }; };
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
    expect(opened.descriptions).toBeGreaterThan(10);

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

  it("masaüstü: menü açıklaması ekran okuyucuya açık ama görsel olarak gizli; gruplar katlanır", async () => {
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/yonetim/magazalar`);
    const nav = await page.evaluate<{
      described: boolean;
      hidden: boolean;
      activeGroupOpen: boolean;
    }>(`(() => {
      const link = document.querySelector("aside a[aria-current=page]");
      const desc = link.querySelector("span span:nth-child(2)");
      return {
        described: (link.textContent ?? "").includes("feed"),
        hidden: desc.getBoundingClientRect().height <= 1,
        activeGroupOpen: link.closest("details").open,
      };
    })()`);
    expect(nav).toEqual({ described: true, hidden: true, activeGroupOpen: true });
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
