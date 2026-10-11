import {
  AdminForbiddenError,
  ExportRefusedError,
  getExportFile,
  policyFromEnv,
} from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { requireFreshCapability } from "../../../../../lib/dal.ts";

/**
 * Dahili dışa aktarım indirme (karar 0102). Yetki + taze giriş + hukuki kapılar
 * core'da; dosya adı yalnızca sabit listeden. Önbelleğe alınmaz, tarayıcı
 * içerik türünü yorumlamaz, her indirme denetime yazılır.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ exportId: string; file: string }> },
): Promise<Response> {
  const { actor, fresh } = await requireFreshCapability("data.export");
  if (!fresh) return new Response("Yeniden giriş gerekli.", { status: 403 });
  const { exportId, file } = await params;
  const id = /^\d{1,9}$/.test(exportId) ? Number(exportId) : Number.NaN;
  try {
    const result = await getExportFile(
      getDatabase(),
      actor,
      id,
      decodeURIComponent(file),
      policyFromEnv(),
    );
    return new Response(result.body, {
      headers: {
        "content-type": result.contentType,
        "content-disposition": `attachment; filename="${result.name}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-content-sha256": result.sha256,
      },
    });
  } catch (error) {
    if (error instanceof AdminForbiddenError) return new Response("Yetki yok.", { status: 403 });
    if (error instanceof ExportRefusedError) {
      return new Response(`Reddedildi: ${error.reason}`, {
        status: 409,
        headers: { "cache-control": "no-store" },
      });
    }
    throw error;
  }
}
