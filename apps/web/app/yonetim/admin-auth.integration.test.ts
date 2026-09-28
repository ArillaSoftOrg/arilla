/**
 * P3 yönetim girişi ve oturum politikası (docs/decisions/0044) - gerçek
 * yerel Postgres; `next/*` taklit edilir. Sayfa ve action'lar arayüz
 * atlanarak doğrudan çağrılır. Uzak adres görülürse test durur.
 */
import { generateRawToken, hashToken } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { NextRequest } from "next/server";
import { isValidElement, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  token: undefined as string | undefined,
  path: undefined as string | undefined,
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
    delete: () => {},
  }),
  headers: async () =>
    new Headers({ "user-agent": "vitest", ...(state.path ? { "x-arilla-path": state.path } : {}) }),
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
  usePathname: () => "/yonetim",
  useRouter: () => ({ refresh: () => {} }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

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
type Role = "user" | "moderator" | "admin";
const userIds = {} as Record<Role, number>;
let merchantId = 0;
const merchantSlug = `p3-merchant-${suffix}`;

/** Yeni oturum: yaş ve boşta kalma süresi dakika cinsinden. */
async function sessionFor(role: Role, ageMinutes = 5, idleMinutes = 1): Promise<string> {
  const raw = generateRawToken();
  await owner((client) =>
    client.query(
      `INSERT INTO session (user_id, token_hash, expires_at, created_at, last_used_at)
       VALUES ($1, $2, now() + interval '30 days',
               now() - ($3 || ' minutes')::interval, now() - ($4 || ' minutes')::interval)`,
      [userIds[role], hashToken(raw), String(ageMinutes), String(idleMinutes)],
    ),
  );
  return raw;
}

async function sessionExists(raw: string): Promise<boolean> {
  return owner(async (client) => {
    const res = await client.query("SELECT 1 FROM session WHERE token_hash = $1", [hashToken(raw)]);
    return res.rows.length > 0;
  });
}

const adminHome = async () => (await import("./page.tsx")).default();
const lexiconPage = async () =>
  (await import("./sozluk/page.tsx")).default({ searchParams: Promise.resolve({}) });
const auditPage = async () =>
  (await import("./denetim/page.tsx")).default({ searchParams: Promise.resolve({}) });

beforeAll(async () => {
  assertLocal("DATABASE_URL");
  await owner(async (client) => {
    for (const role of ["user", "moderator", "admin"] as const) {
      const res = await client.query(
        "INSERT INTO app_user (email, role) VALUES ($1, $2) RETURNING id",
        [`p3-${role}-${suffix}@test.local`, role],
      );
      userIds[role] = Number(res.rows[0].id);
    }
    const merchant = await client.query(
      `INSERT INTO merchant (slug, name, domain, source_type, is_active)
       VALUES ($1, 'P3 Merchant', $2, 'xml_feed', TRUE) RETURNING id`,
      [merchantSlug, `p3-${suffix}.test`],
    );
    merchantId = Number(merchant.rows[0].id);
  });
});

beforeEach(() => {
  state.token = undefined;
  state.path = undefined;
  state.cookies.clear();
  vi.stubEnv("PRODUCT_ACCESS", "");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await owner(async (client) => {
    await client.query("DELETE FROM admin_audit_event WHERE actor_user_id = ANY($1)", [
      Object.values(userIds),
    ]);
    await client.query("DELETE FROM merchant WHERE id = $1", [merchantId]);
    await client.query("DELETE FROM app_user WHERE id = ANY($1)", [Object.values(userIds)]);
  });
  await ownerPool?.end();
});

describe("yetki kapısı", () => {
  it("anonim → yönetim girişi, dönüş yoluyla", async () => {
    state.path = "/yonetim/sozluk?q=ruj";
    expect(await outcome(lexiconPage)).toBe("/yonetim/giris?next=%2Fyonetim%2Fsozluk%3Fq%3Druj");
  });

  it("normal kullanıcı reddedilir (404), yönetici girer", async () => {
    state.token = await sessionFor("user");
    expect(await outcome(adminHome)).toBe("404");
    state.token = await sessionFor("admin");
    expect(await outcome(adminHome)).toBe("ok");
  });

  it("moderatör yeteneğine göre: sözlük evet, denetim hayır", async () => {
    state.token = await sessionFor("moderator");
    expect(await outcome(lexiconPage)).toBe("ok");
    expect(await outcome(auditPage)).toBe("404");
  });
});

describe("yönetim oturumu politikası", () => {
  it("12 saati aşan oturum: yeniden giriş, oturum sunucuda silinir", async () => {
    const raw = await sessionFor("admin", 13 * 60, 1);
    state.token = raw;
    state.path = "/yonetim/denetim";
    expect(await outcome(auditPage)).toBe("/yonetim/giris?next=%2Fyonetim%2Fdenetim&neden=sure");
    expect(await sessionExists(raw)).toBe(false);
    // Aynı çerezle ikinci istek artık anonimdir: yenileyerek aşılamaz.
    expect(await outcome(auditPage)).toBe("/yonetim/giris?next=%2Fyonetim%2Fdenetim");
  });

  it("30 dakika boşta kalan oturum kapanır; 20 dakika kapanmaz", async () => {
    const idle = await sessionFor("moderator", 60, 45);
    state.token = idle;
    expect(await outcome(lexiconPage)).toBe("/yonetim/giris?neden=bosta");
    expect(await sessionExists(idle)).toBe(false);

    state.token = await sessionFor("moderator", 60, 20);
    expect(await outcome(lexiconPage)).toBe("ok");
  });

  it("normal kullanıcının eski oturumu yönetim kuralından etkilenmez", async () => {
    const old = await sessionFor("user", 20 * 60, 120);
    state.token = old;
    expect(await outcome(adminHome)).toBe("404");
    expect(await sessionExists(old)).toBe(true);
  });
});

describe("taze giriş (yüksek etkili mutasyon)", () => {
  const input = () => ({
    merchantId,
    active: false,
    reason: "taze giriş denemesi",
    confirmSlug: merchantSlug,
  });

  it("son 1 saat dışındaki giriş: işlem yapılmaz, yeniden giriş bağlantısı döner", async () => {
    const { setMerchantActiveAction } = await import("./magazalar/actions.ts");
    state.token = await sessionFor("admin", 90, 1);
    state.path = `/yonetim/magazalar/${merchantSlug}`;
    const result = await setMerchantActiveAction(input());
    expect(result).toMatchObject({
      ok: false,
      reauthHref: `/yonetim/giris?next=%2Fyonetim%2Fmagazalar%2F${merchantSlug}&neden=yeniden`,
    });
    const active = await owner((c) =>
      c.query("SELECT is_active FROM merchant WHERE id = $1", [merchantId]),
    );
    expect(active.rows[0].is_active).toBe(true);
  });

  it("son 1 saat içindeki giriş: işlem yapılır", async () => {
    const { setMerchantActiveAction } = await import("./magazalar/actions.ts");
    state.token = await sessionFor("admin", 10, 1);
    expect(await setMerchantActiveAction(input())).toEqual({ ok: true, changed: true });
  });
});

describe("rol düşürme", () => {
  it("aynı oturumla bir sonraki yönetim isteğinde erişim kaybolur", async () => {
    state.token = await sessionFor("moderator");
    expect(await outcome(lexiconPage)).toBe("ok");
    await owner((c) =>
      c.query("UPDATE app_user SET role = 'user' WHERE id = $1", [userIds.moderator]),
    );
    try {
      expect(await outcome(lexiconPage)).toBe("404");
    } finally {
      await owner((c) =>
        c.query("UPDATE app_user SET role = 'moderator' WHERE id = $1", [userIds.moderator]),
      );
    }
  });
});

/** Render edilmemiş JSX ağacında `next` prop'u taşıyan ilk öğe (LoginFormClient). */
function findNextProp(node: ReactNode): string | undefined {
  if (!isValidElement(node)) return undefined;
  const props = node.props as { next?: string; children?: ReactNode };
  if (typeof props.next === "string") return props.next;
  const children = Array.isArray(props.children) ? props.children : [props.children];
  for (const child of children) {
    const found = findNextProp(child as ReactNode);
    if (found) return found;
  }
  return undefined;
}

describe("yönetim girişi ve next güvenliği", () => {
  it("giriş formu yalnızca güvenli bir /yonetim yolu taşır", async () => {
    const { default: Page } = await import("../giris/yonetim/page.tsx");
    const render = async (next: string) =>
      findNextProp(await Page({ searchParams: Promise.resolve({ next }) }));
    expect(await render("/yonetim/sozluk")).toBe("/yonetim/sozluk");
    expect(await render("//evil.example")).toBe("/yonetim");
    expect(await render("/kaydettiklerim")).toBe("/yonetim");
    expect(await render("/yonetim/giris")).toBe("/yonetim");
  });

  async function loginWithEmail(email: string, next: string): Promise<string> {
    const raw = generateRawToken();
    await owner((client) =>
      client.query(
        "INSERT INTO auth_token (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')",
        [email, hashToken(raw)],
      ),
    );
    const { confirmLoginAction } = await import("../giris/dogrula/actions.ts");
    const data = new FormData();
    data.set("token", raw);
    data.set("next", next);
    return outcome(() => confirmLoginAction(data));
  }

  it("yönetim girişinden gelen yönetici next'e, normal kullanıcı kendi akışına", async () => {
    expect(await loginWithEmail(`p3-admin-${suffix}@test.local`, "/yonetim/sozluk")).toBe(
      "/yonetim/sozluk",
    );
    expect(await loginWithEmail(`p3-user-${suffix}@test.local`, "/yonetim")).toBe("/erken-erisim");
    // Normal /giris akışı değişmedi.
    expect(await loginWithEmail(`p3-user-${suffix}@test.local`, "/")).toBe("/erken-erisim");
  });
});

describe("proxy", () => {
  it("/yonetim/giris ayrı sayfaya rewrite edilir, adres değişmez", async () => {
    const { proxy } = await import("../../proxy.ts");
    const response = proxy(
      new NextRequest("http://localhost:3000/yonetim/giris?next=%2Fyonetim%2Fsozluk"),
    );
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-rewrite")).toBe(
      "http://localhost:3000/giris/yonetim?next=%2Fyonetim%2Fsozluk",
    );
  });

  it("oturumsuz yönetim isteği dönüş yoluyla yönetim girişine", async () => {
    const { proxy } = await import("../../proxy.ts");
    const response = proxy(new NextRequest("http://localhost:3000/yonetim/denetim?sayfa=2"));
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/yonetim/giris");
    expect(location.searchParams.get("next")).toBe("/yonetim/denetim?sayfa=2");
  });

  it("yol başlığını proxy yazar; istemcinin sahte başlığı ezilir", async () => {
    const { proxy } = await import("../../proxy.ts");
    const request = new NextRequest("http://localhost:3000/yonetim/sozluk", {
      headers: { cookie: "session=x", "x-arilla-path": "//evil.example" },
    });
    const response = proxy(request);
    expect(response.headers.get("x-middleware-request-x-arilla-path")).toBe("/yonetim/sozluk");
  });
});
