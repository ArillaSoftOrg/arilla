/**
 * `/sss` (docs/decisions/0061): içerik tek kaynaktan, erişilebilir akordeon
 * çıktısı ve FAQPage yapılandırılmış verisi. Veritabanı kullanmaz; JSX sayfa
 * render ettiği için web entegrasyon yapılandırmasında (otomatik JSX) koşar.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PUBLIC_CONTACT_EMAIL } from "../site-config.ts";
import { FAQ_ITEMS, faqPlainText } from "./faq-content.ts";
import SssPage from "./page.tsx";

const html = renderToStaticMarkup(createElement(SssPage));

function jsonLd(): {
  "@type": string;
  mainEntity: { "@type": string; name: string; acceptedAnswer: { text: string } }[];
} {
  const match = html.match(/<script type="application\/ld\+json">(.*?)<\/script>/s);
  if (!match?.[1]) throw new Error("JSON-LD yok");
  return JSON.parse(match[1]);
}

describe("SSS içeriği", () => {
  it("istenen on soru, kalıcı ve tekil kimliklerle", () => {
    expect(FAQ_ITEMS).toHaveLength(10);
    const ids = FAQ_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("arayüzde kullanılmayan kelimeler geçmez (CLAUDE.md, glossary)", () => {
    // E-posta adresi yapılandırmadır (site-config.ts), marka metni değil.
    const text = FAQ_ITEMS.flatMap((item) => [item.question, ...item.answer])
      .join(" ")
      .replaceAll(PUBLIC_CONTACT_EMAIL, "")
      .toLocaleLowerCase("tr");
    for (const banned of ["satın al", "dupe", "ucuz", "arilla"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("bağlantılar yalnızca site içi yollar", () => {
    const links = FAQ_ITEMS.flatMap((item) => item.answer).flatMap((p) =>
      [...p.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]),
    );
    expect(links.length).toBeGreaterThan(0);
    for (const href of links) expect(href).toMatch(/^\/(?!\/)/);
  });
});

describe("SSS sayfası", () => {
  it("akordeon: başlıkta düğme, aria-expanded/controls, etiketli panel", () => {
    const buttons = html.match(/<button[^>]*aria-expanded="false"[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(FAQ_ITEMS.length);
    for (const button of buttons) {
      expect(button).toContain('type="button"');
      expect(button).toMatch(/aria-controls="[^"]+"/);
    }
    expect(html.match(/<h2[^>]*><button/g)).toHaveLength(FAQ_ITEMS.length);
    expect(html.match(/<section[^>]*aria-labelledby="[^"]+"[^>]*hidden=""/g)).toHaveLength(
      FAQ_ITEMS.length,
    );
  });

  it("kapalı yanıtlar sunucu çıktısında yer alır; bağlantılar <a>", () => {
    for (const item of FAQ_ITEMS) {
      expect(html).toContain(`id="${item.id}"`);
      expect(html).toContain(item.question.replace(/'/g, "&#x27;"));
    }
    expect(html).toContain('href="/gizlilik"');
    expect(html).toContain('href="/iletisim"');
    expect(html).not.toContain("](/");
  });

  it("FAQPage verisi sayfadaki metinle aynı, bağlantı sözdizimi yok", () => {
    const data = jsonLd();
    expect(data["@type"]).toBe("FAQPage");
    expect(data.mainEntity.map((q) => q.name)).toEqual(FAQ_ITEMS.map((item) => item.question));
    data.mainEntity.forEach((entry, index) => {
      expect(entry["@type"]).toBe("Question");
      expect(entry.acceptedAnswer.text).toBe(FAQ_ITEMS[index]?.answer.map(faqPlainText).join(" "));
      expect(entry.acceptedAnswer.text).not.toMatch(/\]\(/);
    });
  });
});
