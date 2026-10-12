import { HomeHeader, ProductCard } from "@arilla/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { homeFooterGroups, personalNavLinks, SUBPAGE_SECTION_LINKS } from "./home-footer-groups.ts";

const base = {
  brandLabel: "ManiCepte",
  navItems: [{ label: "Trendler", href: "/trendler" }],
  navAriaLabel: "Ana gezinme",
  accountLabel: "Hesabım",
  loginHref: "/giris",
  loginLabel: "Giriş yap",
  personalNavItems: personalNavLinks(),
  personalNavLabel: "Kişisel",
  logoutLabel: "Çıkış",
};

function drawer(html: string): string {
  return html.slice(html.indexOf("<aside"), html.indexOf("</aside>"));
}

describe("menü paneli", () => {
  it("yardimci baglantiyi ust cubuktan kaldirip menu panelinde tutar", () => {
    const html = renderToStaticMarkup(
      createElement(HomeHeader, {
        ...base,
        accountHref: null,
        utilityLink: { label: "Admin Girişi", href: "/yonetim" },
        utilityInMenuOnly: true,
      }),
    );
    expect(html.match(/Admin Girişi/g)).toHaveLength(1);
    expect(drawer(html)).toContain('href="/yonetim"');
    expect(drawer(html)).toContain("Admin Girişi");
  });

  it("mobil cubukta gizlenen giris eylemini menu panelinde tutar", () => {
    const html = renderToStaticMarkup(
      createElement(HomeHeader, {
        ...base,
        accountHref: null,
        accountInMobileMenuOnly: true,
      }),
    );
    expect(html).toContain('data-mobile-menu-only="true"');
    expect(drawer(html)).toContain('href="/giris"');
    expect(drawer(html)).toContain("Giriş yap");
  });

  it("oturum açıkken kişisel bölüm, hesap alanı ve çıkış; iç bağlantılar aynı sekmede", () => {
    const html = drawer(
      renderToStaticMarkup(
        createElement(HomeHeader, {
          ...base,
          accountHref: "/hesap",
          accountName: "Ayşe",
          accountEmail: "ayse@example.test",
          logoutAction: async () => {},
        }),
      ),
    );
    expect(html).toContain('aria-label="Kişisel"');
    for (const href of ["/kaydettiklerim", "/alarmlar", "/gecmis", "/hesap"]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain("Alarmlarım");
    expect(html).not.toContain("Fiyat Alarmlarım");
    expect(html).toContain("Ayşe");
    expect(html).toContain("ayse@example.test");
    expect(html).toContain("Çıkış");
    expect(html).not.toContain("target=");
  });

  it("oturum yokken özel bağlantı yok, yalnızca Giriş yap", () => {
    const html = drawer(
      renderToStaticMarkup(createElement(HomeHeader, { ...base, accountHref: null })),
    );
    expect(html).not.toContain('aria-label="Kişisel"');
    for (const href of ["/kaydettiklerim", "/alarmlar", "/gecmis", "/hesap"]) {
      expect(html).not.toContain(`href="${href}"`);
    }
    expect(html).toContain('href="/giris"');
    expect(html).toContain("Giriş yap");
    expect(html).not.toContain("<form");
  });
});

describe("ProductCard action", () => {
  it("eylem bağlantının içinde değil, kardeşidir; eylemsiz işaretleme değişmez", () => {
    const props = { href: "/urun/a", title: "A", imageUrl: null, minPrice: 1000 };
    const plain = renderToStaticMarkup(createElement(ProductCard, props));
    expect(plain.startsWith("<a ")).toBe(true);
    const withAction = renderToStaticMarkup(
      createElement(ProductCard, {
        ...props,
        action: createElement("button", { type: "button" }, "x"),
      }),
    );
    const anchor = withAction.slice(withAction.indexOf("<a "), withAction.indexOf("</a>"));
    expect(anchor).not.toContain("<button");
    expect(withAction).toContain("<button");
  });
});

describe("footer Hesap grubu", () => {
  function accountLinks(signedIn: boolean) {
    const group = homeFooterGroups(SUBPAGE_SECTION_LINKS, signedIn).find(
      (g) => g.title === "Hesap",
    );
    return group?.links.map((l) => `${l.label} ${l.href}`) ?? [];
  }

  it("oturum açıkken Hesabım + kişisel sayfalar; oturum yokken yalnızca Giriş yap", () => {
    expect(accountLinks(true)).toEqual([
      "Hesabım /hesap",
      "Kaydettiklerim /kaydettiklerim",
      "Alarmlarım /alarmlar",
      "Geçmişim /gecmis",
    ]);
    expect(accountLinks(false)).toEqual(["Giriş yap /giris"]);
  });
});
