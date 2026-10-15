/**
 * Karar 0114: Admitad (AliExpress) teklifine tiklama uctan uca.
 * Sablon `{affiliate_url}&subid={click_id}`: Admitad deeplink API'sinin urettigi
 * bicimle (rzekl.com/g/<kod>/?subid=..&ulp=..) dogrulandi; beslemedeki takip
 * baglantisi ayni host ve yolu kullanir. Gercek yerel Postgres; `next/*` taklit.
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
const TAG = `t114git${Date.now().toString(36).slice(-6)}`;
const TRACKING =
  "https://rzekl.com/g/0000test0000/?i=5&f_id=14267&ulp=https%3A%2F%2Fs.click.aliexpress.com%2Fdeep_link.htm%3Fdl_target_url%3Dx";

function local(name: string): string {
  const url = process.env[name];
  if (!url) throw new Error(`${name} tanımlı değil`);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error(`${name} yerel değil`);
  }
  return url;
}

type OwnerClient = ReturnType<typeof createDatabase>["$client"];
let pool: OwnerClient | undefined;
const owner = <T>(fn: (c: OwnerClient) => Promise<T>) => {
  pool ??= createDatabase(local("DATABASE_URL_OWNER")).$client;
  return fn(pool);
};

describe("/git/[offerId] - Admitad takip baglantisi", () => {
  let withTracking = 0;
  let withoutTracking = 0;

  beforeAll(async () => {
    local("DATABASE_URL");
    await owner(async (c) => {
      const m = await c.query(
        `INSERT INTO merchant (slug, name, domain, source_type, is_active, affiliate_network,
                               affiliate_status, deeplink_template)
         VALUES ($1, 'AliExpress (test)', $1 || '.test.invalid', 'affiliate_network', TRUE,
                 'admitad', 'active', '{affiliate_url}&subid={click_id}') RETURNING id`,
        [TAG],
      );
      const merchantId = m.rows[0].id;
      const offer = async (ext: string, affiliate: string | null) =>
        Number(
          (
            await c.query(
              `INSERT INTO offer (merchant_id, external_id, url, title_raw, current_price, currency, affiliate_url)
               VALUES ($1, $2, 'https://www.aliexpress.com/item/' || $2 || '.html', 't', 2211, 'USD', $3)
               RETURNING id`,
              [merchantId, ext, affiliate],
            )
          ).rows[0].id,
        );
      withTracking = await offer("1005000000000001", TRACKING);
      withoutTracking = await offer("1005000000000002", null);
    });
  });

  afterAll(async () => {
    await owner(async (c) => {
      await c.query(
        "DELETE FROM click WHERE offer_id IN (SELECT o.id FROM offer o JOIN merchant m ON m.id = o.merchant_id WHERE m.slug = $1)",
        [TAG],
      );
      await c.query(
        "DELETE FROM offer WHERE merchant_id IN (SELECT id FROM merchant WHERE slug = $1)",
        [TAG],
      );
      await c.query("DELETE FROM merchant WHERE slug = $1", [TAG]);
    });
    await pool?.end();
  });

  beforeEach(() => state.cookies.clear());

  async function click(offerId: number): Promise<string> {
    const { GET } = await import("./route.ts");
    try {
      await GET(
        new Request(`http://localhost/git/${offerId}?surface=feed_offers`, {
          headers: { "user-agent": CHROME },
        }),
        { params: Promise.resolve({ offerId: String(offerId) }) },
      );
    } catch (error) {
      if (error instanceof RedirectSignal) return error.to;
      throw error;
    }
    throw new Error("yonlendirme yok");
  }

  it("takip baglantisina subid=click_id ile gider; click kaydi USD tutari TL diye yazmaz", async () => {
    const to = await click(withTracking);
    const row = await owner(
      async (c) =>
        (
          await c.query("SELECT id, surface, price_at_click FROM click WHERE offer_id = $1", [
            withTracking,
          ])
        ).rows,
    );
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ surface: "feed_offers", price_at_click: null });
    expect(to).toBe(`${TRACKING}&subid=${row[0].id}`);
    const url = new URL(to);
    expect(url.hostname).toBe("rzekl.com");
    expect(url.searchParams.get("subid")).toBe(row[0].id);
  });

  it("takip baglantisi yoksa click yine yazilir ve kanonik urun adresine gider", async () => {
    const to = await click(withoutTracking);
    expect(to).toBe("https://www.aliexpress.com/item/1005000000000002.html");
    const n = await owner(
      async (c) =>
        (
          await c.query("SELECT count(*)::int AS n FROM click WHERE offer_id = $1", [
            withoutTracking,
          ])
        ).rows[0].n,
    );
    expect(n).toBe(1);
  });
});
