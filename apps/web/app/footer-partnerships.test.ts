import { SiteFooter } from "@arilla/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { homeFooterGroups, legalFooterGroup, SUBPAGE_SECTION_LINKS } from "./home-footer-groups.ts";
import IcerikUreticileriPage from "./icerik-ureticileri/page.tsx";
import MarkalarIcinPage from "./markalar-icin/page.tsx";
import OrtakliklarPage from "./ortakliklar/page.tsx";

describe("footer iş ortaklıkları", () => {
  it("dört ana grup ve üç ortaklık hedefi sunar; fiyat-stok notunu çizmez", () => {
    const html = renderToStaticMarkup(
      createElement(SiteFooter, {
        brandLabel: "ManiCepte",
        groups: homeFooterGroups(SUBPAGE_SECTION_LINKS),
        legalGroup: legalFooterGroup(),
        copyrightLabel: "© 2026 ManiCepte",
      }),
    );

    for (const label of ["Markalar İçin", "Mağazalar İçin", "İçerik Üreticileri"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain('href="/markalar-icin"');
    expect(html).toContain('href="/ortakliklar"');
    expect(html).toContain('href="/icerik-ureticileri"');
    expect(html).not.toContain("Fiyat ve stok bilgisi mağazalardan alınır");
  });
});

describe("iş ortaklığı geçici sayfaları", () => {
  it.each([
    ["Markalar İçin", MarkalarIcinPage],
    ["Mağazalar İçin", OrtakliklarPage],
    ["İçerik Üreticileri", IcerikUreticileriPage],
  ] as const)("%s başlığını ve geliştirme durumunu gösterir", (title, Page) => {
    const html = renderToStaticMarkup(createElement(Page));
    expect(html).toContain(title);
    expect(html).toContain("Bu sayfa geliştirilme aşamasında.");
  });
});
