import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("./lib/dal.ts", () => ({ verifySession: async () => null }));
vi.mock("./lib/theme-cookie.ts", () => ({ readThemePreference: async () => null }));

type Element = { type: unknown; props: Record<string, unknown> };

function typeName(part: unknown): string | undefined {
  const type = (part as Element | null)?.type;
  if (typeof type === "function") return type.name;
  return typeof type === "string" ? type : undefined;
}

async function shellParts(chrome?: "site" | "chat", showFooterSocial = true): Promise<Element[]> {
  const { PublicSiteShell } = await import("./public-site-shell.tsx");
  const { SUBPAGE_SECTION_LINKS } = await import("./home-footer-groups.ts");
  const tree = (await PublicSiteShell({
    links: SUBPAGE_SECTION_LINKS,
    chrome,
    showFooterSocial,
    children: null,
  })) as Element;
  return (tree.props.children as unknown[]).flat().filter(Boolean) as Element[];
}

// Ilk dinamik import agir (core + db zinciri): varsayilan 5 sn yetmez.
const SLOW = 30_000;

describe("kabuk: sohbet chrome", () => {
  it(
    "varsayılan (site): footer ve normal header var",
    async () => {
      const parts = await shellParts();
      expect(parts.some((part) => typeName(part) === "SiteFooter")).toBe(true);
      const header = parts.find((part) => typeName(part) === "HomeHeader") as Element;
      const footer = parts.find((part) => typeName(part) === "SiteFooter") as Element;
      expect(header.props.variant).toBe("site");
      expect(footer.props.socialGroup).toEqual(
        expect.objectContaining({
          title: "Takipte kal",
          links: [
            expect.objectContaining({
              label: "Instagram",
              href: "https://www.instagram.com/manicepte.tr",
            }),
            expect.objectContaining({
              label: "X",
              href: "https://x.com/ManiCeptetr",
            }),
            expect.objectContaining({
              label: "LinkedIn",
              href: "https://www.linkedin.com/company/manicepte/",
            }),
          ],
        }),
      );
    },
    SLOW,
  );

  it(
    "sayfa kendi takip alanını çizdiğinde footer sosyal grubunu tekrar etmez",
    async () => {
      const parts = await shellParts(undefined, false);
      const footer = parts.find((part) => typeName(part) === "SiteFooter") as Element;
      expect(footer.props.socialGroup).toBeUndefined();
    },
    SLOW,
  );

  it(
    "chat: footer yok (SiteFooter ve EditorialFooter), header sohbet varyantı",
    async () => {
      const parts = await shellParts("chat");
      const names = parts.map(typeName);
      expect(names).not.toContain("SiteFooter");
      expect(names).not.toContain("EditorialFooter");
      const header = parts.find((part) => typeName(part) === "HomeHeader") as Element;
      expect(header.props.variant).toBe("chat");
    },
    SLOW,
  );
});

describe("HomeHeader sohbet varyantı", () => {
  it("işaretlemede data-variant=chat taşır; site varyantı bunu yalnız site olarak taşır", async () => {
    const { HomeHeader } = await import("@arilla/ui");
    const base = {
      brandLabel: "ManiCepte",
      navItems: [{ label: "Trendler", href: "/trendler" }],
      navAriaLabel: "Ana gezinme",
      accountHref: null,
      accountLabel: "Hesabım",
      loginHref: "/giris",
      loginLabel: "Giriş yap",
    };
    const chat = renderToStaticMarkup(createElement(HomeHeader, { ...base, variant: "chat" }));
    const site = renderToStaticMarkup(createElement(HomeHeader, base));
    expect(chat).toContain('data-variant="chat"');
    expect(chat).not.toContain("data-compact");
    expect(site).toContain('data-variant="site"');
  });
});
