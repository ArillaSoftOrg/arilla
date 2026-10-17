/**
 * `/<slug>` takip bağlantısı (karar 0115): gerçek yerel Postgres ve Redis; yalnızca
 * `next/navigation` ve ürün kapısı taklit edilir. Yönlendirme durum kodu, önbellek
 * başlıkları, sayma kuralları (bot/HEAD/ön yükleme sayılmaz), pasif/yok bağlantı
 * ve mevcut link-öneki davranışının korunması.
 */
import { createDatabase } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
vi.mock("../lib/dal.ts", () => ({ requireProductAccess: async () => null }));

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

type Result =
  | { kind: "response"; status: number; headers: Headers }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" };

describe("/[slug] takip bağlantısı", () => {
  const suffix = Date.now().toString(36);
  const slugs = {
    ok: `rt${suffix}ok`,
    off: `rt${suffix}off`,
    ext: `rt${suffix}ext`,
  };
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    assertLocal("DATABASE_URL");
    process.env.APP_URL = "https://manicepte.com";
    await owner(async (c) => {
      const rows = await c.query(
        `INSERT INTO tracking_link (name, slug, target_url, source, campaign, is_active) VALUES
           ('RT ok', $1, '/trendler/yaz', 'instagram', 'yaz26', TRUE),
           ('RT off', $2, '/', NULL, NULL, FALSE),
           ('RT ext', $3, 'https://manicepte.com/blog/yazi?x=1', NULL, NULL, TRUE)
         RETURNING id, slug`,
        [slugs.ok, slugs.off, slugs.ext],
      );
      for (const row of rows.rows) ids[row.slug] = Number(row.id);
    });
  });

  afterAll(async () => {
    await owner(async (c) => {
      await c.query("DELETE FROM tracking_link_click_hour WHERE link_id = ANY($1)", [
        Object.values(ids),
      ]);
      await c.query("DELETE FROM tracking_link WHERE id = ANY($1)", [Object.values(ids)]);
    });
    await ownerPool?.end();
  });

  async function hit(
    slug: string,
    options: { headers?: Record<string, string>; method?: string; query?: string } = {},
  ): Promise<Result> {
    const mod = await import("./route.ts");
    const handler = options.method === "HEAD" ? mod.HEAD : mod.GET;
    const request = new Request(
      `https://manicepte.com/${encodeURIComponent(slug)}${options.query ?? ""}`,
      { method: options.method ?? "GET", headers: options.headers },
    );
    try {
      const res = await handler(request, { params: Promise.resolve({ slug }) });
      return { kind: "response", status: res.status, headers: res.headers };
    } catch (error) {
      if (error instanceof RedirectSignal) return { kind: "redirect", to: error.to };
      if (error instanceof NotFoundSignal) return { kind: "notFound" };
      throw error;
    }
  }

  const clicks = (slug: string) =>
    owner(async (c) =>
      Number(
        (
          await c.query(
            "SELECT COALESCE(SUM(clicks), 0) AS n FROM tracking_link_click_hour WHERE link_id = $1",
            [ids[slug]],
          )
        ).rows[0].n,
      ),
    );

  it("302, önbelleksiz, dizine girmez; hedefe UTM ekler; insan tıklaması sayılır", async () => {
    const result = await hit(slugs.ok, { headers: { "user-agent": CHROME } });
    expect(result.kind).toBe("response");
    if (result.kind !== "response") return;
    expect(result.status).toBe(302);
    expect(result.headers.get("cache-control")).toBe("no-store, max-age=0");
    expect(result.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(result.headers.has("set-cookie")).toBe(false);
    const location = new URL(result.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe("https://manicepte.com/trendler/yaz");
    expect(location.searchParams.get("utm_source")).toBe("instagram");
    expect(location.searchParams.get("utm_campaign")).toBe("yaz26");
    expect(await clicks(slugs.ok)).toBe(1);
  });

  it("büyük harfli slug aynı bağlantıya gider; mutlak hedefin sorgusu korunur", async () => {
    const result = await hit(slugs.ext.toUpperCase(), { headers: { "user-agent": CHROME } });
    expect(result.kind === "response" && result.headers.get("location")).toBe(
      "https://manicepte.com/blog/yazi?x=1",
    );
    expect(await clicks(slugs.ext)).toBe(1);
  });

  it("HEAD, ön yükleme, bot ve User-Agent'sız istek yönlendirilir ama SAYILMAZ", async () => {
    const before = await clicks(slugs.ok);
    const probes: [string, Parameters<typeof hit>[1]][] = [
      ["HEAD", { method: "HEAD", headers: { "user-agent": CHROME } }],
      ["sec-purpose prefetch", { headers: { "user-agent": CHROME, "sec-purpose": "prefetch" } }],
      ["purpose prefetch", { headers: { "user-agent": CHROME, purpose: "prefetch" } }],
      ["x-moz prefetch", { headers: { "user-agent": CHROME, "x-moz": "prefetch" } }],
      [
        "googlebot",
        {
          headers: {
            "user-agent":
              "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
          },
        },
      ],
      ["facebook önizleme", { headers: { "user-agent": "facebookexternalhit/1.1" } }],
      ["curl", { headers: { "user-agent": "curl/8.5.0" } }],
      ["UA yok", { headers: {} }],
    ];
    for (const [name, options] of probes) {
      const result = await hit(slugs.ok, options);
      expect(result.kind, name).toBe("response");
      expect(result.kind === "response" && result.status, name).toBe(302);
    }
    expect(await clicks(slugs.ok)).toBe(before);
  });

  it("eşzamanlı tıklamalar kaybolmaz", async () => {
    const before = await clicks(slugs.ok);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        hit(slugs.ok, {
          headers: { "user-agent": CHROME, "x-forwarded-for": `198.51.100.${i + 1}` },
        }),
      ),
    );
    expect(await clicks(slugs.ok)).toBe(before + 10);
  });

  it("pasif ve olmayan bağlantı 404; pasif bağlantı sayılmaz", async () => {
    expect((await hit(slugs.off, { headers: { "user-agent": CHROME } })).kind).toBe("notFound");
    expect((await hit(`yok${suffix}`, { headers: { "user-agent": CHROME } })).kind).toBe(
      "notFound",
    );
    expect(await clicks(slugs.off)).toBe(0);
  });

  it("tarama trafiği ve bozuk girdi 404 (veritabanı hatası yok)", async () => {
    for (const probe of ["wp-login.php", "a b", "..", "x".repeat(60), "İstanbul"]) {
      const result = await hit(probe, { headers: { "user-agent": CHROME } });
      expect(result.kind, probe).toBe("notFound");
    }
  });

  it("mevcut link-öneki kısayolu korunur: kodlu tek parça adres link aramasına yönlenir", async () => {
    const result = await hit("https://www.example.com/urun/1", {
      headers: { "user-agent": CHROME },
      query: "?a=b",
    });
    expect(result.kind).toBe("redirect");
    if (result.kind !== "redirect") return;
    expect(result.to.startsWith("/ara/link?url=")).toBe(true);
    expect(decodeURIComponent(result.to.split("url=")[1] ?? "")).toBe(
      "https://www.example.com/urun/1?a=b",
    );
  });

  it("sayaç tablosu kişi tanımlayıcısı taşımaz", async () => {
    const columns = await owner((c) =>
      c.query(
        `SELECT column_name FROM information_schema.columns
          WHERE table_name = 'tracking_link_click_hour' ORDER BY ordinal_position`,
      ),
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual(["link_id", "hour", "clicks"]);
  });
});
