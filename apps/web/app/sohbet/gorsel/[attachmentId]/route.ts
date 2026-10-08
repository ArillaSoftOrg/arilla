import { canAccessProduct, isChatDiscoveryEnabled, isUuid, loadChatAttachment } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { verifySession } from "../../../lib/dal.ts";

/**
 * Sohbete eklenen fotograf (karar 0078). Yalnizca sahibine: oturum + `user_id`
 * sorguda; baskasinin, olmayan ya da gecersiz kimlik ayni 404'tur. Paylasilan
 * onbellege girmez (`private, no-store`).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ attachmentId: string }> },
): Promise<Response> {
  const notFound = () =>
    new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  const user = await verifySession();
  if (!isChatDiscoveryEnabled() || !user || !canAccessProduct(user)) return notFound();
  const { attachmentId } = await params;
  if (!isUuid(attachmentId)) return notFound();
  const attachment = await loadChatAttachment(getDatabase(), { userId: user.id, attachmentId });
  if (!attachment) return notFound();
  return new Response(new Uint8Array(attachment.data), {
    headers: {
      "Content-Type": attachment.mimeType,
      "Content-Length": String(attachment.data.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}
