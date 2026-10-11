/**
 * `/git/web/[token]` (karar 0101): imzali internet sonucu cikisi `web_exit_click`
 * satiri yazar ve yonlendirir; imzasiz/suresi dolmus token, kapali bayrak 404;
 * bot/onyukleme istegi 204 (kayit ve yonlendirme yok). Gercek yerel Postgres;
 * `next/*` taklit edilir.
 */
import { signWebExit } from "@arilla/core";
import { createDatabase } from "@arilla/db";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ cookies: new Map<string, string>() }));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = state.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string) => {
      state.cookies.set(name, value);
    },
  }),
}));

class RedirectSignal extends Error {
  constructor(readonly to: string) {
    super(`redirect:${to}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new RedirectSignal(to);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("../../../lib/dal.ts", () => ({ requireProductAccess: async () => null }));

const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
const owner = <T>(fn: (c: OwnerClient) => Promise<T>) => {
  ownerPool ??= createDatabase(assertLocal("DATABASE_URL_OWNER")).$client;
  return fn(ownerPool);
};

const TARGET = "https://shop.com.tr/urun/sony-wh-1000xm5";

function token(overrides: Partial<Parameters<typeof signWebExit>[0]> = {}, ttl?: number): string {
  return signWebExit(
    {
      url: TARGET,
      kind: "exact",
      price: 999_990,
      priceStatus: "verified",
      surface: "search",
      position: 1,
      ...overrides,
    },
    new Date(),
    ttl,
  );
}

describe("/git/web/[token]", () => {
  const sessions: string[] = [];

  beforeEach(() => {
    state.cookies.clear();
    vi.stubEnv("WEB_SEARCH_ENABLED", "true");
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("VERCEL_ENV", "preview");
  });

  afterAll(async () => {
    await owner((c) =>
      c.query("DELETE FROM web_exit_click WHERE session_id = ANY($1)", [sessions]),
    );
    await ownerPool?.end();
  });

  async function hit(t: string, headers: Record<string, string> = { "user-agent": CHROME }) {
    assertLocal("DATABASE_URL");
    const { GET } = await import("./route.ts");
    try {
      const res = await GET(new Request(`http://localhost/git/web/${t}`, { headers }), {
        params: Promise.resolve({ token: t }),
      });
      return { kind: "response" as const, status: res.status };
    } catch (error) {
      if (error instanceof RedirectSignal) return { kind: "redirect" as const, to: error.to };
      if (error instanceof Error && error.message === "notFound")
        return { kind: "notFound" as const };
      throw error;
    }
  }

  const rowsFor = (sessionId: string) =>
    owner(
      async (c) =>
        (await c.query("SELECT * FROM web_exit_click WHERE session_id = $1", [sessionId]))
          .rows as Record<string, unknown>[],
    );

  it("gercek tiklama: tek satir yazar, oturum cerezi acar, hedefe yonlendirir", async () => {
    const result = await hit(token());
    expect(result).toEqual({ kind: "redirect", to: TARGET });
    const sessionId = state.cookies.get("session_id") ?? [...state.cookies.values()][0];
    expect(sessionId).toBeTruthy();
    sessions.push(sessionId as string);
    const rows = await rowsFor(sessionId as string);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      host: "shop.com.tr",
      url: TARGET,
      match_kind: "exact",
      price_status: "verified",
      surface: "search",
    });
    expect(Number(rows[0]?.price_at_click)).toBe(999_990);
  });

  it("imzasiz, bozuk ve suresi dolmus token 404; kayit yok", async () => {
    const before = (await owner((c) => c.query("SELECT count(*)::int AS n FROM web_exit_click")))
      .rows[0].n;
    expect((await hit("abc.def")).kind).toBe("notFound");
    expect((await hit(`${token()}x`)).kind).toBe("notFound");
    expect((await hit(token({}, -10))).kind).toBe("notFound");
    const after = (await owner((c) => c.query("SELECT count(*)::int AS n FROM web_exit_click")))
      .rows[0].n;
    expect(after).toBe(before);
  });

  it("bayrak kapaliyken onceden verilmis token da calismaz (404)", async () => {
    vi.stubEnv("WEB_SEARCH_ENABLED", "");
    expect((await hit(token())).kind).toBe("notFound");
  });

  it("uretimde hukuki onay bayragi olmadan 404", async () => {
    vi.stubEnv("VERCEL_ENV", "production");
    expect((await hit(token())).kind).toBe("notFound");
  });

  it("bot / onyukleme istegi 204: kayit, cerez ve yonlendirme yok", async () => {
    const result = await hit(token(), { "user-agent": "Googlebot/2.1" });
    expect(result).toEqual({ kind: "response", status: 204 });
    expect(state.cookies.size).toBe(0);
  });
});
