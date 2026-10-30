import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SHARE_COPY, ShareButtonClient } from "./share-button-client.tsx";

function render(subject: "product" | "trend" = "product") {
  return renderToStaticMarkup(
    createElement(ShareButtonClient, {
      url: "https://manicepte.com/urun/kosu-ayakkabisi",
      title: "Koşu ayakkabısı",
      subject,
    }),
  );
}

describe("ShareButtonClient", () => {
  const html = render();

  it("gezinmeyen, metinli bir düğme ve boş bir durum bölgesi çizer", () => {
    expect(html).toMatch(/<button[^>]*type="button"[^>]*>[\s\S]*Paylaş<\/button>/);
    expect(html).toContain('role="status"');
    // İkon dekoratiftir; düğmenin adı görünen metindir.
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("aria-label");
    // İlk çizimde sonuç metni ya da yedek alan yok.
    expect(html).not.toContain(SHARE_COPY.copied);
    expect(html).not.toContain(SHARE_COPY.failed);
    expect(html).not.toContain("<input");
  });

  it("metinler copy.md ile aynı; ALL CAPS ve yasak kelime yok", () => {
    const copyDoc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../docs/copy.md"),
      "utf8",
    );
    const texts = [
      SHARE_COPY.action,
      SHARE_COPY.copied,
      SHARE_COPY.failed,
      ...Object.values(SHARE_COPY.failedFieldLabel),
    ];
    for (const text of texts) {
      expect(copyDoc).toContain(`| ${text} |`);
      expect(text).not.toBe(text.toLocaleUpperCase("tr-TR"));
      expect(text.toLocaleLowerCase("tr-TR")).not.toMatch(/satın al|dupe|ucuz/);
    }
    expect(render("trend")).toContain("Paylaş");
  });
});
