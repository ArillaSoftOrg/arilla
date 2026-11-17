/**
 * Kütüphane (karar 0217): gerçek Postgres. Rıza, idempotentlik, 60 satır sınırı, kullanıcı
 * yalıtımı, gizli kategori dışlaması, güncel katalogdan okuma ve saklama süresi.
 */
import type { Database } from "@arilla/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setConsent } from "../account/consent.ts";
import { signInWithIdentity } from "../auth/identity-sign-in.ts";
import { getTestDb, withOwnerClient } from "../test-db.ts";
import {
  clearLibrary,
  hasLibraryConsent,
  LIBRARY_MAX_ROWS,
  listLibrary,
  listLibraryCategories,
  purgeExpiredLibrary,
  recordLibraryCandidates,
  removeLibraryItem,
} from "./library.ts";

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const users: number[] = [];
const products: number[] = [];
const categories: number[] = [];
let db: Database;
let techCategory = 0;
let hiddenCategory = 0;

async function newUser(tag: string, consent = true): Promise<number> {
  const result = await signInWithIdentity(db, {
    provider: "phone",
    subject: `+90556${suffix.slice(-7)}${tag}`,
    email: null,
    emailVerified: false,
    displayName: null,
    ip: "203.0.113.21",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0.0.0 Safari/537.36",
    context: { deviceClass: "desktop", browserFamily: "chrome", countryCode: "TR" },
  });
  users.push(result.user.id);
  // Yeni hesapta `personalization` varsayılan AÇIK yazılır (signup_default); karar açıkça verilir.
  await setConsent(db, {
    userId: result.user.id,
    kind: "personalization",
    granted: consent,
    ip: null,
  });
  return result.user.id;
}

async function newProduct(tag: string, categoryId: number | null, title = `Kütüphane ${tag}`) {
  const id = await withOwnerClient(async (client) => {
    const r = await client.query(
      "INSERT INTO product (slug, title, category_id, min_price, in_stock_count) VALUES ($1, $2, $3, 150000, 1) RETURNING id",
      [`kutuphane-${suffix}-${tag}`, title, categoryId],
    );
    return Number(r.rows[0].id);
  });
  products.push(id);
  return id;
}

async function newCategory(slug: string, name: string, discoverable: boolean) {
  const id = await withOwnerClient(async (client) => {
    const r = await client.query(
      "INSERT INTO category (slug, name, path, is_discoverable) VALUES ($1, $2, $1, $3) RETURNING id",
      [`${slug}-${suffix}`, name, discoverable],
    );
    return Number(r.rows[0].id);
  });
  categories.push(id);
  return id;
}

const T0 = new Date("2026-11-01T10:00:00.000Z");
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeAll(async () => {
  db = getTestDb();
  techCategory = await newCategory("lib-elektronik", "Elektronik", true);
  hiddenCategory = await newCategory("lib-ic-giyim", "İç giyim", false);
});

afterAll(async () => {
  await withOwnerClient(async (client) => {
    if (users.length) await client.query("DELETE FROM app_user WHERE id = ANY($1)", [users]);
    if (products.length) {
      await client.query("DELETE FROM library_item WHERE product_id = ANY($1)", [products]);
      await client.query("DELETE FROM product WHERE id = ANY($1)", [products]);
    }
    if (categories.length)
      await client.query("DELETE FROM category WHERE id = ANY($1)", [categories]);
  });
});

describe("recordLibraryCandidates", () => {
  it("rıza yoksa hiçbir şey yazmaz", async () => {
    const user = await newUser("1", false);
    const p = await newProduct("a1", techCategory);
    expect(await hasLibraryConsent(db, user)).toBe(false);
    expect(
      await recordLibraryCandidates(db, { userId: user, candidates: [{ productId: p, rank: 1 }] }),
    ).toBe("no_consent");
    expect((await listLibrary(db, user)).items).toEqual([]);
  });

  it("aynı ürünü tekrar eklemez; yeni aramadaki ürünler önce gelir", async () => {
    const user = await newUser("2");
    const [a, b, c, d] = await Promise.all(
      ["b1", "b2", "b3", "b4"].map((t) => newProduct(t, techCategory)),
    );
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [a, b, c].map((id, i) => ({ productId: id as number, rank: i + 1 })),
      now: at(0),
    });
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [
        { productId: d as number, rank: 1 },
        { productId: a as number, rank: 2 },
      ],
      now: at(10),
    });
    const { items } = await listLibrary(db, user);
    expect(items.map((i) => i.productId)).toEqual([d, a, b, c]);
    const counts = await withOwnerClient(
      async (client) =>
        (
          await client.query(
            "SELECT surfaced_count, best_rank FROM library_item WHERE user_id=$1 AND product_id=$2",
            [user, a],
          )
        ).rows[0],
    );
    expect(counts).toEqual({ surfaced_count: 2, best_rank: 1 });
  });

  it("katalogda olmayan kimliği ve gizli kategoriyi yazmaz", async () => {
    const user = await newUser("3");
    const hidden = await newProduct("c1", hiddenCategory);
    const ok = await newProduct("c2", techCategory);
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [
        { productId: hidden, rank: 1 },
        { productId: 2_000_000_000, rank: 2 },
        { productId: ok, rank: 3 },
      ],
    });
    expect((await listLibrary(db, user)).items.map((i) => i.productId)).toEqual([ok]);
  });

  it("kullanıcı başına satır sayısını sınırlar", async () => {
    const user = await newUser("4");
    for (let i = 0; i < LIBRARY_MAX_ROWS + 2; i += 3) {
      const ids = await Promise.all([0, 1, 2].map((k) => newProduct(`d${i + k}`, techCategory)));
      await recordLibraryCandidates(db, {
        userId: user,
        candidates: ids.map((id, r) => ({ productId: id, rank: r + 1 })),
        now: at(i),
      });
    }
    const rows = await withOwnerClient(async (client) =>
      Number(
        (await client.query("SELECT count(*) FROM library_item WHERE user_id=$1", [user])).rows[0]
          .count,
      ),
    );
    expect(rows).toBe(LIBRARY_MAX_ROWS);
  });
});

describe("listLibrary", () => {
  it("kullanıcılar birbirinin satırını göremez ve silemez", async () => {
    const alice = await newUser("5");
    const bob = await newUser("6");
    const p = await newProduct("e1", techCategory);
    await recordLibraryCandidates(db, { userId: alice, candidates: [{ productId: p, rank: 1 }] });
    expect((await listLibrary(db, bob)).items).toEqual([]);
    expect(await removeLibraryItem(db, bob, p)).toBe(false);
    expect(await clearLibrary(db, bob)).toBe(0);
    expect((await listLibrary(db, alice)).items).toHaveLength(1);
    expect(await removeLibraryItem(db, alice, p)).toBe(true);
  });

  it("kategori filtresi ve arama; fiyat ve başlık güncel katalogdan gelir", async () => {
    const user = await newUser("7");
    const lamp = await newProduct("f1", techCategory, "Göz yormayan masa lambası");
    const mouse = await newProduct("f2", null, "Kablosuz oyuncu faresi");
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [
        { productId: lamp, rank: 1 },
        { productId: mouse, rank: 2 },
      ],
    });
    expect((await listLibraryCategories(db, user)).map((c) => c.name)).toEqual(["Elektronik"]);
    const tech = await listLibrary(db, user, { categorySlug: `lib-elektronik-${suffix}` });
    expect(tech.items.map((i) => i.productId)).toEqual([lamp]);
    const found = await listLibrary(db, user, { q: "FARESİ" });
    expect(found.items.map((i) => i.productId)).toEqual([mouse]);
    expect((await listLibrary(db, user, { q: "%" })).items).toEqual([]);

    await withOwnerClient((client) =>
      client.query("UPDATE product SET title = 'Yeni ad', min_price = 99900 WHERE id = $1", [lamp]),
    );
    const after = (await listLibrary(db, user)).items.find((i) => i.productId === lamp);
    expect(after?.title).toBe("Yeni ad");
    expect(after?.minPrice).toBe(99900);
  });

  it("keyset sayfalama kayıtsız ve tekrarsız ilerler", async () => {
    const user = await newUser("8");
    const ids = await Promise.all([0, 1, 2, 3, 4].map((k) => newProduct(`g${k}`, techCategory)));
    for (const [i, id] of ids.entries()) {
      await recordLibraryCandidates(db, {
        userId: user,
        candidates: [{ productId: id, rank: 1 }],
        now: at(i),
      });
    }
    const first = await listLibrary(db, user, { limit: 2 });
    const second = await listLibrary(db, user, { limit: 2, cursor: first.nextCursor });
    const third = await listLibrary(db, user, { limit: 2, cursor: second.nextCursor });
    expect([...first.items, ...second.items, ...third.items].map((i) => i.productId)).toEqual(
      [...ids].reverse(),
    );
    expect(third.nextCursor).toBeNull();
  });

  it("ürün silinince satır da gider", async () => {
    const user = await newUser("9");
    const p = await newProduct("h1", techCategory);
    await recordLibraryCandidates(db, { userId: user, candidates: [{ productId: p, rank: 1 }] });
    await withOwnerClient((client) => client.query("DELETE FROM product WHERE id = $1", [p]));
    expect((await listLibrary(db, user)).items).toEqual([]);
  });
});

describe("purgeExpiredLibrary", () => {
  it("180 günden eski satırları siler, yenileri korur", async () => {
    const user = await newUser("10");
    const [oldP, newP] = await Promise.all([
      newProduct("i1", techCategory),
      newProduct("i2", techCategory),
    ]);
    const now = new Date("2027-06-01T00:00:00.000Z");
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [{ productId: oldP, rank: 1 }],
      now: new Date(now.getTime() - 200 * 86_400_000),
    });
    await recordLibraryCandidates(db, {
      userId: user,
      candidates: [{ productId: newP, rank: 1 }],
      now: new Date(now.getTime() - 10 * 86_400_000),
    });
    await purgeExpiredLibrary(db, { now });
    const left = await withOwnerClient(async (client) =>
      (await client.query("SELECT product_id FROM library_item WHERE user_id=$1", [user])).rows.map(
        (r) => Number(r.product_id),
      ),
    );
    expect(left).toEqual([newP]);
  });
});
