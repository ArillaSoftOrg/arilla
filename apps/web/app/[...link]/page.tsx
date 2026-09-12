import { findKnownOfferByUrl, InvalidUrlError } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound, redirect } from "next/navigation";
import { LinkWaitClient } from "./link-wait-client.tsx";

/**
 * docs/routes.md "Link öneki": `/<merchant-url>` kök catch-all. Rezerve slug
 * listesi (`ara`, `urun`, `kategori`, ...) burada AYRICA kontrol edilmez -
 * hiçbiri http(s) ile başlamadığı için aşağıdaki şema kontrolü onları zaten
 * elemeye yeter; gerçek bir rota (örn. `/urun/x`) varsa Next önce ona gider,
 * bu dosyaya hiç düşmez.
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

  const path = link.join("/");
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(sp)) {
    if (typeof value === "string") query.append(key, value);
    else if (Array.isArray(value)) for (const item of value) query.append(key, item);
  }
  const rawUrl = query.size > 0 ? `${path}?${query.toString()}` : path;

  if (!/^https?:\/\//i.test(rawUrl)) notFound();

  let known: Awaited<ReturnType<typeof findKnownOfferByUrl>>;
  try {
    known = await findKnownOfferByUrl(getDatabase(), rawUrl);
  } catch (error) {
    if (error instanceof InvalidUrlError) notFound();
    throw error;
  }

  if (known) redirect(`/urun/${known.productSlug}`);

  return (
    <main style={{ padding: 24, display: "grid", placeItems: "center", minHeight: "50vh" }}>
      <LinkWaitClient urlRaw={rawUrl} />
    </main>
  );
}
