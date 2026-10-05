/**
 * Lansman öncesi landing (karar 0043) - web sınırı. `PRODUCT_ACCESS` açık
 * değilken:
 *
 * - landing yalnızca tanıtımdır: form, arama, ürün bağlantısı, keşif sorgusu
 *   yok; anonim ziyaret veritabanına hiç gitmez
 * - erken erişim eylemi mevcut giriş akışına güvenli `next` ile gider
 * - "Admin Girişi" aynı giriş akışıdır; yetkisiz hesap başarı ekranına düşer
 * - başarı ekranı yeni katılanla geri döneni ayırır, ürüne bağlantı vermez
 * - giriş/geri çağrı yolları proxy'ye takılmaz; döngü yok
 * - kök metadata, site haritası ve robots bayrağı izler; açılınca eski
 *   davranış geri gelir
 *
 * Gerçek yerel Postgres; `next/*` taklit edilir. Uzak adres görülürse durur.
 */
import {
  ADMIN_LOGIN_PATH,
  EARLY_ACCESS_LOGIN_PATH,
  generateRawToken,
  hashToken,
} from "@arilla/core";
import { createDatabase } from "@arilla/db";
import type { FooterGroup } from "@arilla/ui";
import { NextRequest } from "next/server";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  cookies: new Map<string, string>(),
}));

const spies = vi.hoisted(() => ({ getDatabase: 0, getDiscoverySlots: 0 }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "session" && state.token) return { name, value: state.token };
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
    delete: (arg: string | { name: string }) => {
      state.cookies.delete(typeof arg === "string" ? arg : arg.name);
    },
  }),
  headers: async () => new Headers({ "user-agent": "vitest" }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
class NotFoundSignal extends Error {
  constructor() {
    super("notFound");
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new NotFoundSignal();
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
  unstable_cache: <T extends (...args: never[]) => unknown>(fn: T) => fn,
}));

// Servis güvenliği: landing'in veritabanına ve keşif sorgusuna dokunup
// dokunmadığı sayılır. Davranış gerçektir, yalnızca sayaç eklenir.
vi.mock("@arilla/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@arilla/db")>();
  return {
    ...actual,
    getDatabase: (...args: Parameters<typeof actual.getDatabase>) => {
      spies.getDatabase += 1;
      return actual.getDatabase(...args);
    },
  };
});

vi.mock("@arilla/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@arilla/core")>();
  return {
    ...actual,
    getDiscoverySlots: (...args: Parameters<typeof actual.getDiscoverySlots>) => {
      spies.getDiscoverySlots += 1;
      return actual.getDiscoverySlots(...args);
    },
  };
});

function assertLocal(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) {
    throw new Error(`${name} yerel değil (${host}); bu test yalnızca yerel veritabanında çalışır.`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let ownerPool: OwnerClient | undefined;

async function owner<T>(fn: (client: OwnerClient) => Promise<T>): Promise<T> {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
}

/** "ok" ya da yönlendirilen adres ("404" = notFound). */
async function outcome(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "ok";
  } catch (error) {
    if (error instanceof RedirectSignal) return error.to;
    if (error instanceof NotFoundSignal) return "404";
    throw error;
  }
}

const suffix = Date.now();
type Role = "user" | "enrolled" | "moderator" | "admin";
const tokens = {} as Record<Role, string>;
const userIds = {} as Record<Role, number>;

function as(role: Role | null): void {
  state.token = role ? tokens[role] : undefined;
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["user", "enrolled", "moderator", "admin"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`yakinda-${role}-${suffix}@test.local`, role === "enrolled" ? "user" : role],
      );
      userIds[role] = Number(res.rows[0].id);
      tokens[role] = generateRawToken();
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [userIds[role], hashToken(tokens[role])],
      );
    }
    // Bir gün önce katılmış, sonradan dönen kullanıcı.
    await client.query(
      "INSERT INTO early_access (user_id, created_at, updated_at) VALUES ($1, now() - interval '1 day', now() - interval '1 day')",
      [userIds.enrolled],
    );
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "");
  state.cookies.clear();
  spies.getDatabase = 0;
  spies.getDiscoverySlots = 0;
  as(null);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await owner(async (client) => {
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [Object.values(userIds)]);
  });
  await ownerPool?.end();
});

type Element = ReactElement<{ children?: ReactNode; [key: string]: unknown }>;

function typeName(element: unknown): string | undefined {
  return ((element as Element).type as { name?: string }).name;
}

/** Sayfanın kabuk içindeki gövdesi (kabuk async bileşendir; gövde değil). */
function bodyMarkup(element: unknown): string {
  return renderToStaticMarkup((element as Element).props.children as ReactElement);
}

/** Landing'i (ürün kapalıyken ana sayfa) HTML'e çevirir. */
async function landingMarkup(): Promise<string> {
  const { default: HomePage } = await import("./page.tsx");
  const page = await HomePage();
  expect(typeName(page)).toBe("ComingSoonLanding");
  const { ComingSoonLanding } = await import("./coming-soon-landing.tsx");
  const shell = ComingSoonLanding((page as Element).props as { signedIn: boolean });
  return bodyMarkup(shell);
}

const PRODUCT_HREF = /href="\/(urun|kesfet|firsatlar|ara|git|kaydettiklerim|alarmlar|gecmis)\b/;

describe("mod", () => {
  it("ürün kapalıyken ana sayfa lansman öncesi landing'dir", async () => {
    const { default: HomePage } = await import("./page.tsx");
    for (const role of [null, "user", "enrolled", "moderator"] as const) {
      as(role);
      expect(typeName(await HomePage()), String(role)).toBe("ComingSoonLanding");
    }
  });

  it("yalnızca yönetici gerçek siteyi önizler; moderatör göremez", async () => {
    const { default: HomePage } = await import("./page.tsx");
    as("admin");
    expect(typeName(await HomePage())).not.toBe("ComingSoonLanding");
    as("moderator");
    expect(typeName(await HomePage())).toBe("ComingSoonLanding");
    // Moderatörün yönetim konsolu yetkisi değişmedi.
    const { requireCapability } = await import("./lib/dal.ts");
    expect(await outcome(() => requireCapability("admin.access"))).toBe("ok");
    expect(await outcome(() => requireCapability("matching.review"))).toBe("ok");
    expect(await outcome(() => requireCapability("users.read"))).toBe("404");
  });

  it("ürün açıkken moderatör de ürün ana sayfasını görür", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    const { default: HomePage } = await import("./page.tsx");
    as("moderator");
    expect(typeName(await HomePage())).not.toBe("ComingSoonLanding");
  });

  it("PRODUCT_ACCESS=open eski siteyi geri getirir", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    const { default: HomePage } = await import("./page.tsx");
    as(null);
    const page = await HomePage();
    expect(typeName(page)).not.toBe("ComingSoonLanding");
    const { generateMetadata } = await import("./page.tsx");
    expect(generateMetadata()).toEqual({ alternates: { canonical: "/" } });
  });

  it("bayrak kapalı kalmak için ayar istemez; bilinmeyen değer de kapalıdır", async () => {
    const { default: HomePage } = await import("./page.tsx");
    for (const value of ["", "closed", "coming-soon", "true"]) {
      vi.stubEnv("PRODUCT_ACCESS", value);
      expect(typeName(await HomePage()), value).toBe("ComingSoonLanding");
    }
  });
});

describe("landing içeriği", () => {
  it("anonim: marka, durum, başlık, tek eylem; ürün/arama/form yok", async () => {
    const html = await landingMarkup();
    expect(html).toContain("ManiCepte yakında.");
    expect(html).toContain("Erken Erişim");
    expect(html).toContain("Aradığın ürünü bul. Fiyatları karşılaştır. Daha akıllı alışveriş yap.");
    expect(html).toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html).toContain('href="#nasil-calisacak"');
    expect(html).toContain('id="nasil-calisacak"');
    expect(html).toContain("Ne aradığını anlatarak bul");
    expect(html).toContain("ManiCepte&#x27;yi geliştiriyoruz.");
    expect(html).toContain("Son güncelleme: Eylül 2026");
    expect(html).not.toMatch(PRODUCT_HREF);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    // Tek h1.
    expect(html.match(/<h1/g)).toHaveLength(1);
    // Yasak kelimeler ve sahte sayı yok (docs/copy.md).
    // Yalnızca görünen metin (öznitelikler değil: CTA adresinde %2F var).
    const text = html.replace(/<[^>]*>/g, " ");
    expect(text).not.toMatch(/satın al|dupe|ucuz|\d\s?%|%\s?\d|\bTL\b|₺/i);
  });

  it("sosyal hesap tanımlı değilken bağlantı gösterilmez", async () => {
    const html = await landingMarkup();
    expect(html).not.toMatch(/instagram|tiktok|linkedin/i);
  });

  it("girişli kullanıcı: tekrar katıl yerine durum", async () => {
    as("enrolled");
    const html = await landingMarkup();
    expect(html).toContain('href="/erken-erisim"');
    expect(html).toContain("Erken erişim listesindesin.");
    expect(html).not.toContain(`href="${EARLY_ACCESS_LOGIN_PATH}"`);
    expect(html).not.toMatch(PRODUCT_HREF);
  });

  it("kök metadata: yakında başlığı, kanonik /", async () => {
    const { generateMetadata } = await import("./page.tsx");
    const meta = generateMetadata();
    expect(meta.title).toBe("ManiCepte – Yakında");
    expect(meta.alternates?.canonical).toBe("/");
    expect(String(meta.description)).toContain("Erken erişim listesine katıl");
    expect(meta.openGraph?.siteName).toBe("ManiCepte");
  });
});

describe("kabuk: header ve footer", () => {
  async function shellParts(): Promise<{
    loginHref: unknown;
    utilityLink: unknown;
    groups: readonly FooterGroup[];
  }> {
    const { PublicSiteShell } = await import("./public-site-shell.tsx");
    const { SUBPAGE_SECTION_LINKS } = await import("./home-footer-groups.ts");
    const tree = (await PublicSiteShell({
      links: SUBPAGE_SECTION_LINKS,
      children: null,
    })) as Element;
    const parts = (tree.props.children as Element[]).flat();
    const header = parts.find((part) => typeName(part) === "HomeHeader") as Element;
    const footer = parts.find((part) => typeName(part) === "SiteFooter") as Element;
    return {
      loginHref: header.props.loginHref,
      utilityLink: header.props.utilityLink,
      groups: footer.props.groups as readonly FooterGroup[],
    };
  }

  it("anonim: erken erişim ve sade Admin Girişi; ürün bağlantısı yok", async () => {
    const { loginHref, utilityLink, groups } = await shellParts();
    expect(loginHref).toBe(EARLY_ACCESS_LOGIN_PATH);
    // Header'da sade, birincil olmayan Admin Girişi: aynı giriş akışı.
    expect(utilityLink).toEqual({ label: "Admin Girişi", href: ADMIN_LOGIN_PATH });
    const links = groups.flatMap((group) => group.links);
    expect(links).toContainEqual(
      expect.objectContaining({ label: "Admin Girişi", href: ADMIN_LOGIN_PATH }),
    );
    expect(links.map((link) => link.href).join(" ")).not.toMatch(
      /\/(urun|kesfet|firsatlar|ara|kaydettiklerim|alarmlar|gecmis)\b/,
    );
  });

  it("girişli normal kullanıcı: durum bağlantısı, Admin Girişi yok", async () => {
    as("user");
    const { groups, utilityLink } = await shellParts();
    expect(utilityLink).toBeUndefined();
    const links = groups.flatMap((group) => group.links);
    expect(links).toContainEqual(expect.objectContaining({ href: "/erken-erisim" }));
    expect(links.some((link) => link.label === "Admin Girişi")).toBe(false);
  });
});

describe("servis güvenliği", () => {
  it("anonim landing veritabanına ve keşif sorgusuna hiç gitmez", async () => {
    await landingMarkup();
    const { PublicSiteShell } = await import("./public-site-shell.tsx");
    const { SUBPAGE_SECTION_LINKS } = await import("./home-footer-groups.ts");
    await PublicSiteShell({ links: SUBPAGE_SECTION_LINKS, children: null });
    expect(spies.getDatabase).toBe(0);
    expect(spies.getDiscoverySlots).toBe(0);
  });

  it("girişli kullanıcıda yalnızca oturum doğrulaması; keşif sorgusu yok", async () => {
    as("user");
    await landingMarkup();
    expect(spies.getDiscoverySlots).toBe(0);
  });

  it("ürün açıkken (karşılaştırma) keşif sorgusu çalışır", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    const { default: HomePage } = await import("./page.tsx");
    await HomePage();
    expect(spies.getDiscoverySlots).toBe(1);
  });
});

describe("erken erişim akışı", () => {
  it("giriş ekranı erişilebilir; erken erişim başlığı, admin girişinde nötr başlık", async () => {
    const { default: GirisPage } = await import("./giris/page.tsx");
    const early = renderToStaticMarkup(
      (await GirisPage({
        searchParams: Promise.resolve({ next: "/erken-erisim" }),
      })) as ReactElement,
    );
    expect(early).toContain("Erken erişime katıl. Hesabınla devam et ya da yeni hesap aç.");
    expect(early).toContain("ManiCepte");
    const admin = renderToStaticMarkup(
      (await GirisPage({ searchParams: Promise.resolve({ next: "/yonetim" }) })) as ReactElement,
    );
    expect(admin).toContain("Hesabınla giriş yap.");
    expect(admin).not.toContain("Erken erişime katıl.");
  });

  async function loginWithEmail(email: string, next: string): Promise<string> {
    const raw = generateRawToken();
    await owner((client) =>
      client.query(
        "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
        [email, hashToken(raw)],
      ),
    );
    const { confirmLoginAction } = await import("./giris/dogrula/actions.ts");
    const data = new FormData();
    data.set("token", raw);
    data.set("next", next);
    return outcome(() => confirmLoginAction(data));
  }

  async function earlyAccessRows(email: string): Promise<number> {
    const res = await owner((client) =>
      client.query(
        "SELECT count(*)::int AS n FROM early_access e JOIN app_user u ON u.id = e.user_id WHERE u.email = $1",
        [email],
      ),
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  it("yeni ziyaretçi: CTA → giriş → kayıt → başarı ekranı; tekrar giriş idempotent", async () => {
    const email = `yakinda-yeni-${suffix}@test.local`;
    const next = new URL(EARLY_ACCESS_LOGIN_PATH, "http://x").searchParams.get("next") ?? "";
    expect(await loginWithEmail(email, next)).toBe("/erken-erisim");
    expect(await earlyAccessRows(email)).toBe(1);
    expect(await loginWithEmail(email, next)).toBe("/erken-erisim");
    expect(await earlyAccessRows(email)).toBe(1);
    await owner((client) => client.query("DELETE FROM app_user WHERE email = $1", [email]));
  });

  it("Admin Girişi: normal hesap /yonetim'e dönmez, yönetici döner", async () => {
    const next = new URL(ADMIN_LOGIN_PATH, "http://x").searchParams.get("next") ?? "";
    expect(await loginWithEmail(`yakinda-user-${suffix}@test.local`, next)).toBe("/erken-erisim");
    expect(await loginWithEmail(`yakinda-admin-${suffix}@test.local`, next)).toBe("/yonetim");
  });

  it("moderatör: girişten sonra yalnızca yönetim konsoluna, ürüne değil; listeye yazılmaz", async () => {
    const email = `yakinda-moderator-${suffix}@test.local`;
    expect(await loginWithEmail(email, "/yonetim/eslestirme")).toBe("/yonetim/eslestirme");
    expect(await loginWithEmail(email, "/urun/x")).toBe("/yonetim");
    expect(await loginWithEmail(email, "/")).toBe("/yonetim");
    expect(await earlyAccessRows(email)).toBe(0);
    const { default: Page } = await import("./erken-erisim/page.tsx");
    as("moderator");
    expect(await outcome(Page)).toBe("/yonetim");
  });

  it("başarı ekranı: yeni katılan ve geri dönen kullanıcı için durum; ürün bağlantısı yok", async () => {
    const { default: Page } = await import("./erken-erisim/page.tsx");
    const { joinEarlyAccessAction } = await import("./erken-erisim/actions.ts");

    as("user");
    expect(await outcome(joinEarlyAccessAction)).toBe("/erken-erisim");
    expect(await outcome(joinEarlyAccessAction)).toBe("/erken-erisim");
    // Karar 0058: ilk katılımda yayındaki onboarding formuna yönlendirilir;
    // "Şimdilik geç" sonrası başarı ekranı kullanıcıyı bloke etmeden açılır.
    expect(await outcome(Page)).toBe("/anket/seni-taniyalim");
    const { skipSurveyAction } = await import("./anket/[slug]/actions.ts");
    expect(await outcome(() => skipSurveyAction("seni-taniyalim", "link"))).toBe("/erken-erisim");
    const fresh = bodyMarkup(await Page());
    expect(fresh).toContain("Erken erişim listesine alındın.");
    expect(fresh).toContain("ManiCepte açıldığında sana haber vereceğiz.");
    expect(fresh).not.toMatch(PRODUCT_HREF);

    as("enrolled");
    const returning = bodyMarkup(await Page());
    expect(returning).toContain("Erken erişim listemizdesin.");
    expect(returning).not.toContain("Erken erişim listesine alındın.");
    expect(returning).not.toContain("Listeye katıl");
  });

  it("doğrudan /erken-erisim: anonim girişe, yönetici ürüne", async () => {
    const { default: Page } = await import("./erken-erisim/page.tsx");
    as(null);
    expect(await outcome(Page)).toBe("/giris");
    as("admin");
    expect(await outcome(Page)).toBe("/");
  });
});

describe("yönlendirme ve döngü", () => {
  it("giriş ve geri çağrı yolları proxy'ye takılmaz", async () => {
    const { proxy, config } = await import("../proxy.ts");
    const open = [
      "/",
      "/erken-erisim",
      "/giris",
      "/giris/dogrula",
      "/giris/google",
      "/giris/google/callback",
      "/giris/apple",
      "/giris/apple/callback",
      "/giris/telefon",
      "/giris/telefon/kod-gonder",
      "/giris/telefon/dogrula",
      "/gizlilik",
      "/kvkk-aydinlatma",
      "/cerez",
      "/kosullar",
      "/affiliate-aciklamasi",
      "/sirket-bilgileri",
      "/iletisim",
      "/hakkinda",
      "/blog",
      "/ortakliklar",
      "/geri-bildirim",
      "/anket/ornek-form",
      "/api/cron/cleanup-auth",
    ];
    for (const path of open) {
      expect(
        proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get("location"),
        path,
      ).toBeNull();
      // Eşleştirici bu yolları hiç yakalamaz.
      expect(
        config.matcher.some(
          (pattern) =>
            path === pattern.replace(/\/:path\*$/, "") ||
            path.startsWith(pattern.replace(/:path\*$/, "")),
        ),
        path,
      ).toBe(false);
    }
  });

  it("kapıdan geçemeyen her istek, kendisi açık olan bir sayfaya gider", async () => {
    const { default: HomePage } = await import("./page.tsx");
    const { default: GirisPage } = await import("./giris/page.tsx");
    const { default: EarlyPage } = await import("./erken-erisim/page.tsx");
    // anonim: ürün → "/" (açık), /erken-erisim → /giris (açık)
    as(null);
    expect(await outcome(HomePage)).toBe("ok");
    expect(await outcome(() => GirisPage({ searchParams: Promise.resolve({}) }))).toBe("ok");
    // normal kullanıcı: ürün → /erken-erisim (açık)
    as("user");
    expect(await outcome(EarlyPage)).toBe("ok");
    expect(await outcome(HomePage)).toBe("ok");
  });

  it("404: ürün kapalıyken ürün bağlantısı ve arama önerisi yok", async () => {
    const { default: NotFound } = await import("./not-found.tsx");
    const html = bodyMarkup(NotFound());
    expect(html).not.toMatch(PRODUCT_HREF);
    expect(html).not.toContain("#trendler");
  });
});

describe("SEO", () => {
  it("kapalıyken site haritası ve robots ürün yollarını duyurmaz", async () => {
    const pages = await (await import("./sitemap-sayfalar.xml/route.ts")).GET();
    const xml = await pages.text();
    expect(xml).toContain("<loc>");
    expect(xml).not.toMatch(/\/(kesfet|firsatlar|urun)/);
    const index = await (await import("./sitemap.xml/route.ts")).GET();
    expect(await index.text()).not.toContain("/sitemaps/urun/");
    const robots = (await import("./robots.ts")).default();
    const disallow = [robots.rules].flat().flatMap((rule) => [rule?.disallow ?? []].flat());
    expect(disallow).toEqual(expect.arrayContaining(["/urun/", "/kesfet", "/firsatlar", "/ara"]));
    // Landing ve yasal sayfalar taranabilir.
    expect(disallow).not.toContain("/");
    expect(disallow).not.toContain("/gizlilik");
  });

  it("açıkken ürün sayfaları haritaya ve taramaya geri döner", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    const pages = await (await import("./sitemap-sayfalar.xml/route.ts")).GET();
    expect(await pages.text()).toContain("/kesfet");
    const robots = (await import("./robots.ts")).default();
    const disallow = [robots.rules].flat().flatMap((rule) => [rule?.disallow ?? []].flat());
    expect(disallow).not.toContain("/urun/");
    expect(disallow).not.toContain("/kesfet");
  });
});

describe("yapılandırma yardımcıları", () => {
  it("sosyal bağlantılar: yalnızca tanımlı ve https olanlar, sabit sırayla", async () => {
    const { configuredSocialLinks, SOCIAL_PROFILES } = await import("./site-config.ts");
    // Bugün hiçbir resmi hesap tanımlı değil: hiçbiri gösterilmez.
    expect(Object.values(SOCIAL_PROFILES).every((value) => value === null)).toBe(true);
    expect(configuredSocialLinks()).toEqual([]);
    expect(
      configuredSocialLinks({
        instagram: "http://instagram.example/x",
        tiktok: " ",
        linkedin: "https://linkedin.example/company/x",
      }),
    ).toEqual([
      { network: "linkedin", label: "LinkedIn", href: "https://linkedin.example/company/x" },
    ]);
  });

  it("başarı ekranı durumu: kayıt yok / az önce / daha önce", async () => {
    const { earlyAccessState, JUST_JOINED_WINDOW_MS } = await import("./erken-erisim/state.ts");
    const now = new Date("2026-09-28T12:00:00Z");
    expect(earlyAccessState(null, now)).toBe("join");
    expect(earlyAccessState({ createdAt: new Date(now.getTime() - 1000) }, now)).toBe(
      "just_joined",
    );
    expect(
      earlyAccessState({ createdAt: new Date(now.getTime() - JUST_JOINED_WINDOW_MS - 1) }, now),
    ).toBe("returning");
  });
});
