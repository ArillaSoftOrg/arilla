/**
 * P2 ürün kapısı - web sınırı. `PRODUCT_ACCESS` açık değilken:
 *
 * - anonim: public sayfalar (landing, yasal) açık; ürün yolları landing'e
 * - normal kullanıcı: ürün sayfaları, server action'lar ve route handler'lar
 *   `/erken-erisim`'e yönlenir ve veri yazmaz (arayüz atlanarak doğrudan çağrı)
 * - moderatör ve yönetici: kapıyı geçer
 * - giriş sonrası: normal kullanıcı her zaman başarı ekranına
 *
 * Gerçek yerel Postgres; `next/*` taklit edilir. Uzak adres görülürse durur.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { NextRequest } from "next/server";
import type { ReactElement } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  cookies: new Map<string, string>(),
}));

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

type Outcome = "ok" | string;

/** "ok" ya da yönlendirilen adres ("404" = notFound). */
async function outcome(fn: () => Promise<unknown>): Promise<Outcome> {
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
type Role = "user" | "moderator" | "admin";
const tokens = {} as Record<Role, string>;
const userIds = {} as Record<Role, number>;
let productId = 0;
let productSlug = "";

function as(role: Role | null): void {
  state.token = role ? tokens[role] : undefined;
}

async function savedCount(userId: number): Promise<number> {
  return owner(async (client) => {
    const res = await client.query("SELECT count(*)::int AS n FROM saved_item WHERE user_id = $1", [
      userId,
    ]);
    return Number(res.rows[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["user", "moderator", "admin"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`gate-${role}-${suffix}@test.local`, role],
      );
      userIds[role] = Number(res.rows[0].id);
      tokens[role] = generateRawToken();
      await client.query(
        "INSERT INTO session (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
        [userIds[role], hashToken(tokens[role])],
      );
    }
    productSlug = `gate-urun-${suffix}`;
    const product = await client.query(
      "INSERT INTO product (slug, title) VALUES ($1, 'Kapı Ürünü') RETURNING id",
      [productSlug],
    );
    productId = Number(product.rows[0].id);
  });
});

beforeEach(() => {
  vi.stubEnv("PRODUCT_ACCESS", "");
  state.cookies.clear();
  as(null);
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await owner(async (client) => {
    await client.query("DELETE FROM saved_item WHERE product_id = $1", [productId]);
    await client.query("DELETE FROM alert WHERE product_id = $1", [productId]);
    await client.query("DELETE FROM product WHERE id = $1", [productId]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [Object.values(userIds)]);
  });
  await ownerPool?.end();
});

/** Ürün sayfaları ve meta veri - arayüz olmadan doğrudan çağrılır. */
const PRODUCT_PAGES: { name: string; call: () => Promise<unknown> }[] = [
  { name: "/kesfet", call: async () => (await import("./kesfet/page.tsx")).default() },
  { name: "/firsatlar", call: async () => (await import("./firsatlar/page.tsx")).default() },
  {
    name: "/ara",
    call: async () =>
      (await import("./ara/page.tsx")).default({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "/ara/link",
    call: async () =>
      (await import("./ara/link/page.tsx")).default({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "/ara/gorsel",
    call: async () =>
      (await import("./ara/gorsel/page.tsx")).default({ searchParams: Promise.resolve({}) }),
  },
  {
    name: "/urun/[slug] meta",
    call: async () =>
      (await import("./urun/[slug]/page.tsx")).generateMetadata({
        params: Promise.resolve({ slug: productSlug }),
      }),
  },
  {
    name: "/urun/[slug]",
    call: async () =>
      (await import("./urun/[slug]/page.tsx")).default({
        params: Promise.resolve({ slug: productSlug }),
        searchParams: Promise.resolve({}),
      }),
  },
  {
    name: "/[...link] kısayolu",
    call: async () =>
      (await import("./[...link]/page.tsx")).default({
        params: Promise.resolve({ link: ["https:", "magaza.example", "urun"] }),
        searchParams: Promise.resolve({}),
      }),
  },
  {
    name: "/kaydettiklerim",
    call: async () => (await import("./kaydettiklerim/page.tsx")).default(),
  },
  { name: "/alarmlar", call: async () => (await import("./alarmlar/page.tsx")).default() },
  { name: "/gecmis", call: async () => (await import("./gecmis/page.tsx")).default() },
];

describe("ürün sayfaları", () => {
  it.each(PRODUCT_PAGES)("normal kullanıcı $name → /erken-erisim", async ({ call }) => {
    as("user");
    expect(await outcome(call)).toBe("/erken-erisim");
  });

  it.each(
    PRODUCT_PAGES.filter(
      (page) => !["/kaydettiklerim", "/alarmlar", "/gecmis"].includes(page.name),
    ),
  )("anonim $name → landing (/)", async ({ call }) => {
    as(null);
    expect(await outcome(call)).toBe("/");
  });

  // Karar 0043: lansman öncesi önizleme yalnızca yöneticinin.
  it("moderatör kapıyı GEÇEMEZ (yönetim konsolu yetkisi ürün kilidini açmaz)", async () => {
    as("moderator");
    for (const page of PRODUCT_PAGES) {
      expect([page.name, await outcome(page.call)]).toEqual([page.name, "/erken-erisim"]);
    }
    const { saveItemAction } = await import("./urun/[slug]/actions.ts");
    expect(await outcome(() => saveItemAction(productId))).toBe("/erken-erisim");
    expect(await savedCount(userIds.moderator)).toBe(0);
    const { GET } = await import("./git/[offerId]/route.ts");
    expect(
      await outcome(() =>
        GET(new Request("http://localhost:3000/git/1"), {
          params: Promise.resolve({ offerId: "1" }),
        }),
      ),
    ).toBe("/erken-erisim");
  });

  it("ürün açıkken moderatör de geçer (normal mod değişmedi)", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    as("moderator");
    expect(await outcome(async () => (await import("./kesfet/page.tsx")).default())).toBe("ok");
  });

  it.each(["admin"] as const)("%s kapıyı geçer", async (role) => {
    as(role);
    for (const page of PRODUCT_PAGES) {
      const result = await outcome(page.call);
      // Geçen istek kapıya takılmaz. Sayfanın kendi dalı çalışabilir (sorgusuz
      // /ara/link → /ara, id'siz /ara/gorsel → 404) ama kapının iki çıktısı
      // (başarı ekranı ya da landing) asla.
      expect(["/erken-erisim", "/"], `${role} ${page.name}: ${result}`).not.toContain(result);
    }
  });

  it("ürün açıkken normal kullanıcı da geçer", async () => {
    vi.stubEnv("PRODUCT_ACCESS", "open");
    as("user");
    expect(await outcome(async () => (await import("./kesfet/page.tsx")).default())).toBe("ok");
  });
});

describe("server action ve route handler'lar (arayüz atlanarak)", () => {
  it("normal kullanıcı kaydet/alarm ile veri yazamaz", async () => {
    as("user");
    const { saveItemAction, createAlertAction } = await import("./urun/[slug]/actions.ts");
    expect(await outcome(() => saveItemAction(productId))).toBe("/erken-erisim");
    expect(await outcome(() => createAlertAction({ productId, kind: "restock" }))).toBe(
      "/erken-erisim",
    );
    expect(await savedCount(userIds.user)).toBe(0);
  });

  it("normal kullanıcı arama, link ve liste action'larını çağıramaz", async () => {
    as("user");
    const calls: [string, () => Promise<unknown>][] = [
      [
        "uploadImageForSearch",
        async () => (await import("./ara/gorsel/actions.ts")).uploadImageForSearch(new FormData()),
      ],
      [
        "startLinkSearchAction",
        async () =>
          (await import("./ara/link/actions.ts")).startLinkSearchAction("https://magaza.example/u"),
      ],
      [
        "pollLinkSearchAction",
        async () => (await import("./ara/link/actions.ts")).pollLinkSearchAction("x"),
      ],
      [
        "enqueueLinkResolutionAction",
        async () =>
          (await import("./[...link]/actions.ts")).enqueueLinkResolutionAction(
            "https://magaza.example/u",
          ),
      ],
      [
        "removeSavedItemAction",
        async () => (await import("./kaydettiklerim/actions.ts")).removeSavedItemAction(productId),
      ],
      [
        "deleteAlertAction",
        async () => (await import("./alarmlar/actions.ts")).deleteAlertAction(1),
      ],
      [
        "clearHistoryAction",
        async () => (await import("./gecmis/actions.ts")).clearHistoryAction(),
      ],
    ];
    for (const [name, call] of calls) {
      expect([name, await outcome(call)]).toEqual([name, "/erken-erisim"]);
    }
  });

  it("/git çıkışı: kapı click kaydından önce", async () => {
    as("user");
    const { GET } = await import("./git/[offerId]/route.ts");
    const call = () =>
      GET(new Request("http://localhost:3000/git/1"), {
        params: Promise.resolve({ offerId: "1" }),
      });
    expect(await outcome(call)).toBe("/erken-erisim");
    as(null);
    expect(await outcome(call)).toBe("/");
  });

  it("yönetici ürün action'ını kullanabilir", async () => {
    as("admin");
    const { saveItemAction } = await import("./urun/[slug]/actions.ts");
    expect(await saveItemAction(productId)).toBe("ok");
    expect(await savedCount(userIds.admin)).toBe(1);
  });
});

describe("public sayfalar, landing ve başarı ekranı", () => {
  it("proxy: anonim ürün yolu landing'e, public sayfa serbest", async () => {
    const { proxy } = await import("../proxy.ts");
    const product = proxy(new NextRequest(`http://localhost:3000/urun/${productSlug}`));
    expect(new URL(product.headers.get("location") ?? "").pathname).toBe("/");
    for (const path of ["/gizlilik", "/giris", "/kosullar"]) {
      expect(
        proxy(new NextRequest(`http://localhost:3000${path}`)).headers.get("location"),
      ).toBeNull();
    }

    vi.stubEnv("PRODUCT_ACCESS", "open");
    const open = proxy(new NextRequest(`http://localhost:3000/urun/${productSlug}`));
    expect(open.headers.get("location")).toBeNull();
  });

  it("ana sayfa: anonim ve normal kullanıcıya landing, yöneticiye ürün", async () => {
    const { default: HomePage } = await import("./page.tsx");
    as(null);
    const anonymous = (await HomePage()) as ReactElement<{ signedIn: boolean }>;
    expect((anonymous.type as { name?: string }).name).toBe("ComingSoonLanding");
    expect(anonymous.props.signedIn).toBe(false);

    as("user");
    const member = (await HomePage()) as ReactElement<{ signedIn: boolean }>;
    expect(member.props.signedIn).toBe(true);

    as("admin");
    const staff = (await HomePage()) as ReactElement;
    expect((staff.type as { name?: string }).name).not.toBe("ComingSoonLanding");
  });

  it("yasal sayfa anonim için açık", async () => {
    as(null);
    expect(await outcome(async () => (await import("./gizlilik/page.tsx")).default())).toBe("ok");
  });

  it("/erken-erisim: normal kullanıcı görür, yönetici ürüne, anonim girişe", async () => {
    const { default: Page } = await import("./erken-erisim/page.tsx");
    as("user");
    expect(await outcome(Page)).toBe("ok");
    as("admin");
    expect(await outcome(Page)).toBe("/");
    as(null);
    expect(await outcome(Page)).toBe("/giris");
  });

  it("kaydı olmayan girişli kullanıcı listeye elle katılabilir (idempotent)", async () => {
    as("user");
    const { joinEarlyAccessAction } = await import("./erken-erisim/actions.ts");
    expect(await outcome(joinEarlyAccessAction)).toBe("/erken-erisim");
    expect(await outcome(joinEarlyAccessAction)).toBe("/erken-erisim");
    const rows = await owner((client) =>
      client.query("SELECT count(*)::int AS n FROM early_access WHERE user_id = $1", [
        userIds.user,
      ]),
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("site haritası: ürün kapalıyken ürün sayfaları ve parçalar yok", async () => {
    const pages = await (await import("./sitemap-sayfalar.xml/route.ts")).GET();
    const xml = await pages.text();
    expect(xml).toContain("/gizlilik");
    expect(xml).not.toContain("/kesfet");
    const shard = await (await import("./sitemaps/urun/[shard]/route.ts")).GET(
      new Request("http://localhost:3000/sitemaps/urun/1.xml"),
      { params: Promise.resolve({ shard: "1.xml" }) },
    );
    expect(shard.status).toBe(404);
  });
});

describe("giriş sonrası yönlendirme", () => {
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

  it("normal kullanıcı next ne olursa olsun başarı ekranına; yönetici next'e", async () => {
    expect(await loginWithEmail(`gate-user-${suffix}@test.local`, "/alarmlar")).toBe(
      "/erken-erisim",
    );
    expect(await loginWithEmail(`gate-admin-${suffix}@test.local`, "/yonetim")).toBe("/yonetim");
  });

  it("tekrar girişte de aynı başarı ekranı", async () => {
    expect(await loginWithEmail(`gate-user-${suffix}@test.local`, "/")).toBe("/erken-erisim");
  });
});
