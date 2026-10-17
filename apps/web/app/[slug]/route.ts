import {
  classifyClickRequest,
  linkSearchHref,
  recordTrackingClick,
  resolveTrackingLink,
  targetPolicyFromEnv,
  urlFromPrefixSegments,
  withinClickRateLimit,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { notFound, redirect } from "next/navigation";
import { clientIp } from "../lib/client-ip.ts";
import { requireProductAccess } from "../lib/dal.ts";

/**
 * `/<slug>` takip bağlantısı (docs/decisions/0115): tek parçalı, sistem rotası
 * olmayan yollar. Önce yönetimden tanımlı kısa bağlantı aranır; bulunamazsa
 * kök catch-all'un (`[...link]`, karar 0035) davranışı AYNEN uygulanır, hiçbiri
 * değilse 404. Çok parçalı yollar (`/https:/...`) bu rotaya hiç düşmez.
 *
 * - 302 + `no-store`: hedef sonradan değişebilir ya da pasife alınabilir.
 * - HEAD, ön yükleme ve botlar yönlendirilir ama SAYILMAZ; sayaç yazımı ve
 *   Redis önbelleği yönlendirmeyi asla düşürmez.
 * - Sayaca IP, User-Agent, çerez yazılmaz; IP yalnızca dakikalık tavan için
 *   HMAC'li kısa ömürlü Redis anahtarında kullanılır.
 * - Sayfa dizine girmez (`X-Robots-Tag`); hedef doğrulaması core'dadır.
 */
export const dynamic = "force-dynamic";

async function handle(request: Request, params: Promise<{ slug: string }>): Promise<Response> {
  const { slug } = await params;
  const db = getDatabase();

  // APP_URL eksik/bozuksa takip bağlantısı çözülemez; link-öneki davranışı yine çalışır.
  let policy: ReturnType<typeof targetPolicyFromEnv> | null = null;
  try {
    policy = targetPolicyFromEnv();
  } catch {
    policy = null;
  }
  const resolved = policy ? await resolveTrackingLink(db, slug, policy) : null;
  if (resolved) {
    if (classifyClickRequest(request) === "human") {
      try {
        if (await withinClickRateLimit(resolved.id, clientIp(request.headers))) {
          await recordTrackingClick(db, resolved.id);
        }
      } catch (error) {
        // Sayaç hatası yönlendirmeyi bozmaz; hata metni (olası bağlantı bilgisi) yazılmaz.
        console.error(
          "[takip-baglantisi] sayac yazilamadi",
          error instanceof Error ? error.name : "unknown",
        );
      }
    }
    return new Response(null, {
      status: 302,
      headers: {
        Location: resolved.location,
        "Cache-Control": "no-store, max-age=0",
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  }

  // Tanımlı kısa bağlantı değil: mevcut link-öneki kısayolu (tek parça, kodlu olabilir).
  let segments: string[];
  try {
    segments = [decodeURIComponent(slug)];
  } catch {
    notFound();
  }
  const query = new URL(request.url).searchParams.toString();
  const rawUrl = urlFromPrefixSegments(segments, query);
  if (!rawUrl) notFound();
  await requireProductAccess();
  redirect(linkSearchHref(rawUrl));
}

export async function GET(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(request, params);
}

export async function HEAD(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(request, params);
}
