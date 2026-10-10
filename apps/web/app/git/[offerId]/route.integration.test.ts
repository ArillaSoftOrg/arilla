/**
 * `/git/[offerId]`: gercek kullanici tiklamasi tek `click` satiri uretir ve
 * yonlendirir; onyukleme/HEAD/bot istekleri 204 alir (click, cerez, yonlendirme
 * yok). Gercek yerel Postgres; `next/*` taklit edilir.
 */
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
vi.mock("../../lib/dal.ts", () => ({ requireProductAccess: async () => null }));

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

describe("/git/[offerId]", () => {
  let offerId = 0;
  let offerProductId: string | null = null;
  const sessions: string[] = [];

  beforeAll(async () => {
    assertLocal("DATABASE_URL");
    const row = await owner(
      async (c) =>
        (
          await c.query(
            `SELECT o.id, o.product_id FROM offer o JOIN merchant m ON m.id = o.merchant_id
              WHERE m.affiliate_status = 'active' AND o.is_active AND o.product_id IS NOT NULL
              ORDER BY o.id ASC LIMIT 1`,
          )
        ).rows[0],
    );
    offerId = Number(row.id);
    offerProductId = row.product_id;
  });

  beforeEach(() => state.cookies.clear());

  afterAll(async () => {
    await owner((c) => c.query("DELETE FROM click WHERE session_id = ANY($1)", [sessions]));
    await ownerPool?.end();
  });

  async function hit(
    path: string,
    headers: Record<string, string>,
    method = "GET",
  ): Promise<{ kind: "redirect"; to: string } | { kind: "response"; status: number }> {
    const { GET } = await import("./route.ts");
    try {
      const res = await GET(new Request(`http://localhost${path}`, { method, headers }), {
        params: Promise.resolve({ offerId: String(offerId) }),
      });
      return { kind: "response", status: res.status };
    } catch (error) {
      if (error instanceof RedirectSignal) return { kind: "redirect", to: error.to };
      throw error;
    }
  }

  const clicksFor = (sessionId: string) =>
    owner(
      async (c) =>
        (await c.query("SELECT * FROM click WHERE session_id = $1", [sessionId])).rows as Record<
          string,
          unknown
        >[],
    );

  it("a real click: one row with product_id, validated position, surface; then redirects", async () => {
    const result = await hit(`/git/${offerId}?surface=compare&pos=3`, { "user-agent": CHROME });
    expect(result.kind).toBe("redirect");
    const sessionId = state.cookies.get("session_id") ?? "";
    sessions.push(sessionId);
    const rows = await clicksFor(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      surface: "compare",
      result_position: 3,
      product_id: offerProductId,
      source_similarity_kind: null,
    });
  });

  it("untrusted metadata is dropped: bad pos, pos on non-list surface, similarity kind from URL", async () => {
    await hit(`/git/${offerId}?surface=product_primary&pos=2&sk=visual`, { "user-agent": CHROME });
    const sessionId = state.cookies.get("session_id") ?? "";
    sessions.push(sessionId);
    expect(await clicksFor(sessionId)).toMatchObject([
      { result_position: null, source_similarity_kind: null },
    ]);
    state.cookies.set("session_id", sessionId);
    // pencere icindeki tekrar ayni satiri kullanir
    await hit(`/git/${offerId}?surface=search&pos=9999`, { "user-agent": CHROME });
    expect(await clicksFor(sessionId)).toHaveLength(1);
  });

  it("a repeat within the window reuses the row and still redirects", async () => {
    const first = await hit(`/git/${offerId}?surface=search`, { "user-agent": CHROME });
    const sessionId = state.cookies.get("session_id") ?? "";
    sessions.push(sessionId);
    const second = await hit(`/git/${offerId}?surface=search`, { "user-agent": CHROME });
    expect(first.kind).toBe("redirect");
    expect(second.kind).toBe("redirect");
    expect(await clicksFor(sessionId)).toHaveLength(1);
  });

  it.each([
    ["Sec-Purpose prefetch", { "user-agent": CHROME, "sec-purpose": "prefetch" }, "GET"],
    ["Purpose prefetch", { "user-agent": CHROME, purpose: "prefetch" }, "GET"],
    ["HEAD", { "user-agent": CHROME }, "HEAD"],
    [
      "Googlebot",
      { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" },
      "GET",
    ],
    ["no user agent", {}, "GET"],
  ] as const)("%s: 204, no click, no cookie", async (_name, headers, method) => {
    const before = await owner(
      async (c) => (await c.query("SELECT count(*)::int AS n FROM click")).rows[0].n,
    );
    const result = await hit(`/git/${offerId}?surface=search`, { ...headers }, method);
    expect(result).toEqual({ kind: "response", status: 204 });
    expect(state.cookies.size).toBe(0);
    const after = await owner(
      async (c) => (await c.query("SELECT count(*)::int AS n FROM click")).rows[0].n,
    );
    expect(after).toBe(before);
  });
});
