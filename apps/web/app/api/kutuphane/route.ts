import {
  canAccessProduct,
  hasLibraryConsent,
  LIBRARY_QUERY_MAX_LENGTH,
  listLibrary,
  listLibraryCategories,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { verifySession } from "../../lib/dal.ts";

const NO_STORE = {
  "Cache-Control": "private, no-store",
  "X-Robots-Tag": "noindex, nofollow",
} as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;

/**
 * Kütüphane (karar 0217): oturumdaki kullanıcının ürün vitrini. `user_id` YALNIZCA oturumdan
 * gelir, parametreden asla. Menü açılınca çağrılır (başlık her sayfada sorgu yapmaz).
 */
export async function GET(request: Request): Promise<Response> {
  const user = await verifySession();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  if (!canAccessProduct(user)) {
    return Response.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });
  }
  const params = new URL(request.url).searchParams;
  const kategori = params.get("kategori");
  const q = (params.get("q") ?? "").slice(0, LIBRARY_QUERY_MAX_LENGTH);
  const cursor = params.get("cursor");
  const db = getDatabase();
  const [page, categories, consent] = await Promise.all([
    listLibrary(db, user.id, {
      categorySlug: kategori && SLUG.test(kategori) ? kategori : null,
      q,
      cursor: cursor && cursor.length <= 64 ? cursor : null,
    }),
    listLibraryCategories(db, user.id),
    hasLibraryConsent(db, user.id),
  ]);
  return Response.json(
    {
      consent,
      categories,
      nextCursor: page.nextCursor,
      items: page.items.map((item) => ({
        productId: item.productId,
        slug: item.slug,
        title: item.title,
        imageUrl: item.primaryImageUrl,
        brand: item.brandName,
        minPrice: item.inStock ? item.minPrice : null,
      })),
    },
    { headers: NO_STORE },
  );
}
