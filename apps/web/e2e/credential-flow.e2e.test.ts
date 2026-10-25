/**
 * E-posta + şifre arayüzü, gerçek başsız Chrome ile (karar 0150; sürücü
 * `cdp.ts`). Masaüstü (1440) ve dokunmatik mobil (390) ekranda: kayıt →
 * e-posta (Mailpit) → doğrulama onayı → oturum → çıkış → giriş (yanlış/doğru
 * şifre) → şifremi unuttum → sıfırlama → yeni şifreyle giriş. Her ekranda belge
 * yatay taşmıyor, dokunmatikte ana düğme ≥ 44px. Chrome yoksa atlanır.
 *
 *   E2E_BASE_URL=http://localhost:3111 MAILPIT_API=http://localhost:8025 \
 *   SMTP/Redis/Postgres: yerel (sunucuyla aynı); SCREENSHOT_DIR isteğe bağlı.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
const MAILPIT = process.env.MAILPIT_API ?? "http://localhost:8025";
const CHROME = findChrome();
const SHOTS = process.env.SCREENSHOT_DIR;
const PASSWORD = "Mavi-Kedi-Pazar-42";
const NEW_PASSWORD = "Yeni-Sifre-Hazir-77";
const TAG = Date.now().toString(36);

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900, touch: false },
  { name: "mobile", width: 390, height: 844, touch: true },
] as const;

let browser: Browser | undefined;
let page: CdpPage;

async function until<T>(fn: () => Promise<T | false | null | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 80; i++) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`zaman aşımı: ${what}`);
}

/** Hidrasyon bitmeden tıklama etkisiz kalabilir: koşul sağlanana dek tekrar tıklar. */
async function clickUntil(
  selector: string,
  done: () => Promise<boolean>,
  what: string,
): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await reveal(selector);
    await page.click(selector);
    for (let j = 0; j < 4; j++) {
      if (await done()) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`zaman aşımı: ${what}`);
}

const here = () => page.evaluate<string>("location.pathname + location.search");
const text = () => page.evaluate<string>("document.body.innerText");

async function fill(name: string, value: string): Promise<void> {
  await page.evaluate(`(() => {
    const el = document.querySelector('input[name=${JSON.stringify(name)}]');
    if (!el) throw new Error('alan yok: ${name}');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}

/** Dokunmatik ekranda düğme görünüm alanının dışında kalabilir: önce görünür kılınır. */
async function reveal(selector: string): Promise<void> {
  await page.evaluate(
    `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({ block: "center" })`,
  );
}

async function submit(): Promise<void> {
  await reveal("form button[type=submit]");
  await page.click("form button[type=submit]");
}

async function shot(label: string, vp: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(
    join(SHOTS, `${vp}-${label}.png`),
    Buffer.from(await page.screenshot(true), "base64"),
  );
}

async function checkLayout(vp: (typeof VIEWPORTS)[number], label: string): Promise<void> {
  const overflow = await page.evaluate<number>(
    "document.documentElement.scrollWidth - document.documentElement.clientWidth",
  );
  expect(overflow, `${label}: yatay taşma`).toBeLessThanOrEqual(0);
  if (vp.touch) {
    const small = await page.evaluate<
      string[]
    >(`[...document.querySelectorAll('form button, form input')]
      .filter((el) => el.type !== 'hidden' && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().height < 44)
      .map((el) => el.name || el.textContent)`);
    expect(small, `${label}: 44px altı kontroller`).toEqual([]);
  }
  await shot(label, vp.name);
}

async function mailLink(email: string, path: string): Promise<string> {
  return until(async () => {
    const search = await fetch(
      `${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const id = ((await search.json()) as { messages?: { ID: string }[] }).messages?.[0]?.ID;
    if (!id) return false;
    const { Text } = (await (await fetch(`${MAILPIT}/api/v1/message/${id}`)).json()) as {
      Text: string;
    };
    const link = new RegExp(`https?://\\S+${path}\\S*`).exec(Text)?.[0];
    // E-postadaki köken `APP_URL`'dir; test sunucusu başka portta olabilir.
    return link ? `${BASE}${new URL(link).pathname}${new URL(link).search}` : false;
  }, `e-posta ${path}`);
}

beforeAll(async () => {
  if (!CHROME) return;
  browser = await Browser.launch(CHROME);
});

afterAll(async () => {
  await browser?.close();
});

describe.each(VIEWPORTS)("e-posta + şifre arayüzü ($name)", (vp) => {
  it.skipIf(!CHROME)("uçtan uca akış", async () => {
    page = await (browser as Browser).newPage();
    await page.setViewport(vp);
    await page.send("Network.clearBrowserCookies");
    const email = `e2e-${TAG}-${vp.name}@example.test`;

    // Giriş ekranı: e-posta seçeneği görünür.
    await page.goto(`${BASE}/giris`);
    expect(await text()).toContain("E-posta ile devam edin");
    await checkLayout(vp, "giris");

    // Kayıt: sunucu doğrulaması (kısa şifre); geçerli kayıt "e-postanı kontrol et" gösterir.
    await page.goto(`${BASE}/giris/kayit`);
    expect(await text()).toContain("Hizmet Şartlarını");
    await checkLayout(vp, "kayit");
    await fill("email", email);
    await fill("password", "kisa");
    await submit();
    // Sunucu doğrulaması: kısa şifre alan hatası gösterir ve e-posta alanı korunur.
    await until(
      async () => (await text()).includes("Şifre en az 10 karakter olmalı."),
      "kısa şifre hatası",
    );
    expect(await page.evaluate<string>("document.querySelector('input[name=email]').value")).toBe(
      email,
    );
    await fill("email", email);
    await fill("password", PASSWORD);
    await submit();
    await until(
      async () => (await text()).includes("E-postanı kontrol et"),
      "kayıt sonrası bildirim",
    );
    await checkLayout(vp, "kayit-gonderildi");

    // Doğrulama: GET yalnızca onay formu; düğme hesabı açar ve oturum verir.
    const verifyUrl = await mailLink(email, "/giris/eposta-dogrula");
    await page.goto(verifyUrl);
    expect(await text()).toContain("Doğrula ve giriş yap");
    await checkLayout(vp, "dogrula");
    await submit();
    await until(async () => (await here()) === "/", "doğrulama sonrası yönlendirme");
    await page.goto(`${BASE}/hesap`);
    expect(await here()).toBe("/hesap"); // oturum açık (giriş sayfasına atılmadı)
    await page.goto(`${BASE}/hesap/sifre`);
    expect(await text()).toContain("Şifreni değiştir");
    await checkLayout(vp, "hesap-sifre");

    // Aynı doğrulama bağlantısı ikinci kez çalışmaz.
    await page.send("Network.clearBrowserCookies");
    await page.goto(verifyUrl);
    await submit();
    await until(
      async () => (await here()).startsWith("/giris/eposta?durum=gecersiz"),
      "kullanılmış bağlantı",
    );
    expect(await text()).toContain("geçersiz ya da daha önce kullanılmış");
    await checkLayout(vp, "kullanilmis");

    // Giriş: yanlış şifre genel hata verir, doğru şifre oturum açar.
    await page.goto(`${BASE}/giris/eposta`);
    await checkLayout(vp, "eposta-giris");
    await fill("email", email);
    await fill("password", "Yanlis-Sifre-123");
    await submit();
    await until(
      async () => (await text()).includes("E-posta adresi ya da şifre hatalı."),
      "hatalı giriş",
    );
    expect(await here()).toBe("/giris/eposta");
    await fill("password", PASSWORD);
    await submit();
    await until(async () => (await here()) === "/", "giriş sonrası yönlendirme");

    // Şifremi unuttum -> sıfırlama -> yeni şifreyle giriş.
    await page.send("Network.clearBrowserCookies");
    await page.goto(`${BASE}/giris/sifre-unuttum`);
    await checkLayout(vp, "unuttum");
    await fill("email", email);
    await submit();
    await until(async () => (await text()).includes("Bağlantıyı gönderdik"), "sıfırlama bildirimi");
    const resetUrl = await mailLink(email, "/giris/sifre-sifirla");
    await page.goto(resetUrl);
    await checkLayout(vp, "sifirla");
    await fill("password", NEW_PASSWORD);
    await fill("confirm", NEW_PASSWORD.replace("77", "78"));
    await submit();
    await until(async () => (await text()).includes("Şifreler aynı değil."), "uyuşmayan şifre");
    // Hata sonrası form sıfırlanır (şifre alanları temizlenir): ikisi de yeniden girilir.
    await fill("password", NEW_PASSWORD);
    await fill("confirm", NEW_PASSWORD);
    await submit();
    await until(
      async () => (await here()).startsWith("/giris/eposta?durum=sifre_degisti"),
      "sıfırlama sonrası yönlendirme",
    );
    expect(await text()).toContain("Şifren kaydedildi");
    await checkLayout(vp, "sifre-degisti");

    await fill("email", email);
    await fill("password", PASSWORD); // eski şifre artık geçmez
    await submit();
    await until(
      async () => (await text()).includes("E-posta adresi ya da şifre hatalı."),
      "eski şifre reddi",
    );
    await fill("password", NEW_PASSWORD);
    await submit();
    await until(async () => (await here()) === "/", "yeni şifreyle giriş");
  });

  it.skipIf(!CHROME)(
    "erken erişim kaydı, şifre göster/gizle, güçlü şifre ve süresi dolan bağlantı",
    async () => {
      page = await (browser as Browser).newPage();
      await page.setViewport(vp);
      await page.send("Network.clearBrowserCookies");
      const email = `e2e-ux-${TAG}-${vp.name}@example.test`;
      const passwordType = () =>
        page.evaluate<string>("document.querySelector('input[name=password]').type");
      const passwordValue = () =>
        page.evaluate<string>("document.querySelector('input[name=password]').value");
      const tag = (labelText: string, attr: string) =>
        page.evaluate(`(() => {
          const el = [...document.querySelectorAll('button, a')].find((n) => n.textContent.includes(${JSON.stringify(labelText)}));
          if (!el) throw new Error('öğe yok: ${labelText}');
          el.setAttribute('data-e2e', ${JSON.stringify(attr)});
        })()`);

      // Erken erişim: Google/Apple aynı, e-posta seçeneği doğrudan kayıt ekranına.
      await page.goto(`${BASE}/giris?next=%2Ferken-erisim&kayit=1`);
      const hrefs = await page.evaluate<string[]>(
        "[...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))",
      );
      // Google/Apple seçenekleri kalır (yerelde yapılandırılmamışsa "kullanılamıyor" notuyla);
      // bağlantı biçimleri birim testte doğrulanır.
      expect(await text()).toContain("Google ile devam edin");
      expect(await text()).toContain("Apple ile devam edin");
      expect(hrefs).toContain("/giris/kayit?next=%2Ferken-erisim");
      await checkLayout(vp, "erken-erisim-secenekler");
      await tag("E-posta ile devam edin", "email-choice");
      await page.click("[data-e2e=email-choice]");
      await until(async () => (await here()).startsWith("/giris/kayit"), "kayıt ekranı");
      expect(await here()).toContain("next=%2Ferken-erisim");
      // Giriş niyeti ayrı: normal giriş e-posta ekranına gider.
      await page.goto(`${BASE}/giris?next=%2Ferken-erisim`);
      expect(
        await page.evaluate<string[]>(
          "[...document.querySelectorAll('a')].map((a) => a.getAttribute('href'))",
        ),
      ).toContain("/giris/eposta?next=%2Ferken-erisim");

      // Kayıt ekranı: ad alanı yok; şifre göster/gizle fare ve klavyeyle çalışır.
      await page.goto(`${BASE}/giris/kayit?next=%2Ferken-erisim`);
      expect(await text()).toContain("Zaten hesabın var mı? Giriş yap");
      expect(await page.evaluate<boolean>("!document.querySelector('input[name=name]')")).toBe(
        true,
      );
      expect(await passwordType()).toBe("password");
      expect(
        await page.evaluate<string>("document.querySelector('input[name=password]').autocomplete"),
      ).toBe("new-password");
      await clickUntil(
        "button[aria-controls]",
        async () => (await passwordType()) === "text",
        "şifreyi göster",
      );
      expect(
        await page.evaluate<string>("document.querySelector('button[aria-controls]').ariaLabel"),
      ).toBe("Şifreyi gizle");
      expect(
        await page.evaluate<string>("document.querySelector('button[aria-controls]').ariaPressed"),
      ).toBe("true");
      await page.click("button[aria-controls]");
      await until(async () => (await passwordType()) === "password", "şifreyi gizle");

      // Klavye: şifre alanından Tab ile düğmeye gelinir (yerel <button>: Enter/Space çalışır).
      await page.evaluate("document.querySelector('input[name=password]').focus()");
      await page.press("Tab");
      expect(
        await page.evaluate<string>(
          "document.activeElement.getAttribute('aria-label') + ':' + document.activeElement.tagName",
        ),
      ).toBe("Şifreyi göster:BUTTON");

      // Güçlü şifre oluştur: alana yazılır, görünür olur, 20 karakter.
      await tag("Güçlü şifre oluştur", "gen");
      await clickUntil(
        "[data-e2e=gen]",
        async () => (await passwordValue()).length === 20,
        "şifre üretimi",
      );
      const generated = await passwordValue();
      expect(await passwordType()).toBe("text");
      expect(await text()).toContain("Güçlü bir şifre oluşturduk");
      expect(await text()).toContain("Şifreyi kopyala");
      await checkLayout(vp, "kayit-guclu-sifre");

      // Sunucu hatası (Apple gizli adresi) sonrası üretilen şifre kaybolmaz.
      await fill("email", `x-${TAG}@privaterelay.appleid.com`);
      await submit();
      await until(async () => (await text()).includes("gizli e-posta adresiyle"), "sunucu hatası");
      expect(await passwordValue()).toBe(generated);

      // Geçerli adres: yeni bilgilendirme metni (15 dakika).
      await fill("email", email);
      await submit();
      await until(async () => (await text()).includes("E-postanı kontrol et"), "kayıt bildirimi");
      expect(await text()).toContain(
        "Hesabını doğrulaman için e-posta adresine bir bağlantı gönderdik. Bağlantı 15 dakika geçerlidir.",
      );
      expect(await text()).not.toContain("60 dakika");
      const firstUrl = await mailLink(email, "/giris/eposta-dogrula");

      // Süresi dolmuş bağlantı: anlaşılır mesaj + açık yeniden gönderme formu.
      const owner = createDatabase(requireLocal("DATABASE_URL_OWNER")).$client;
      await owner.query(
        "UPDATE email_credential_token SET expires_at = now() - interval '1 minute' WHERE email = $1",
        [email],
      );
      await page.goto(firstUrl);
      await submit();
      await until(
        async () => (await here()).startsWith("/giris/eposta?durum=suresi_doldu"),
        "süresi dolmuş bağlantı",
      );
      expect(await text()).toContain(
        "Doğrulama bağlantısının süresi dolmuş (15 dakika geçerlidir)",
      );
      expect(await page.evaluate<boolean>("!!document.querySelector('details[open]')")).toBe(true);
      await checkLayout(vp, "suresi-doldu");
      await page.evaluate(
        "(() => { const f = document.querySelector('details form'); f.querySelector('input[name=email]').setAttribute('data-e2e', 'resend-email'); f.querySelector('button[type=submit]').setAttribute('data-e2e', 'resend-submit'); })()",
      );
      await page.evaluate(`(() => {
        const el = document.querySelector('[data-e2e=resend-email]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(email)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await reveal("[data-e2e=resend-submit]");
      await page.click("[data-e2e=resend-submit]");
      await until(
        async () => (await text()).includes("doğrulama bağlantısını tekrar gönderdik"),
        "yeniden gönderim bildirimi",
      );
      const secondUrl = await until(async () => {
        const url = await mailLink(email, "/giris/eposta-dogrula");
        return url !== firstUrl ? url : false;
      }, "yeni doğrulama e-postası");
      await page.goto(secondUrl);
      await submit();
      await until(async () => !(await here()).startsWith("/giris"), "yeni bağlantıyla doğrulama");
      await owner.end();
    },
  );
});
