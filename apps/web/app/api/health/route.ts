/**
 * Canlilik (liveness) ucu (docs/decisions/0109). Hicbir bagimliliga dokunmaz:
 * Docker `HEALTHCHECK` ve harici izleme yalnizca "surec istek alabiliyor mu"
 * diye sorar. Veritabani/Redis durumu `/api/health/ready`'dedir; gecici bir
 * bagimlilik kopmasi konteyneri yeniden baslatmasin diye ayri tutulur.
 */
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
