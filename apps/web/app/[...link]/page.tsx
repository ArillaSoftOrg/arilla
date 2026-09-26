import { linkSearchHref, urlFromPrefixSegments } from "@arilla/core";
import { notFound, redirect } from "next/navigation";

/**
 * docs/routes.md "Link öneki": `/<merchant-url>` kök catch-all. Rezerve slug
 * listesi (`ara`, `urun`, `kategori`, ...) burada AYRICA kontrol edilmez -
 * hiçbiri http(s) ile başlamadığı için şema kontrolü onları zaten elemeye
 * yeter; gerçek bir rota (örn. `/urun/x`) varsa Next önce ona gider, bu
 * dosyaya hiç düşmez.
 *
 * Bu rota yalnızca bir KISAYOLDUR (docs/decisions/0031): dış adresi geri
 * kurar ve kanonik link araması adresine (`/ara/link?url=...`) yönlendirir.
 * Çözümleme, bekleme ve sonuç tek yerde - arama kutusuna yapıştırılan link de
 * aynı adrese gelir.
 */
export default async function LinkPage({
  params,
  searchParams,
}: {
  params: Promise<{ link: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { link } = await params;
  const sp = await searchParams;

  // Parçalar kodlu gelebilir (`https%3A`); bozuk kodlama gerçek bir 404'tür.
  let segments: string[];
  try {
    segments = link.map((segment) => decodeURIComponent(segment));
  } catch {
    notFound();
  }

  // Dış adresin kendi sorgusu Arilla adresinin sorgusu olarak gelir.
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }

  const rawUrl = urlFromPrefixSegments(segments, query.toString());
  if (!rawUrl) notFound();

  redirect(linkSearchHref(rawUrl));
}
