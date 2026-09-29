import { readAppUrl } from "@arilla/core";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { rememberReferralCode } from "../../giris/referral-cookie.ts";

/**
 * docs/routes.md `/davet/<kod>` (0047): davet kodunu cereze yazar ve girise
 * yonlendirir. Sayfa degil, yonlendirme: modal yok, indekslenmez
 * (`robots.ts`, `X-Robots-Tag`). Gecersiz kod sessizce yok sayilir;
 * kullanici yine girise gider. Davet yalnizca bu tarayicida acilan YENI
 * hesaba baglanir.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ kod: string }> },
): Promise<NextResponse> {
  const { kod } = await params;
  rememberReferralCode(await cookies(), kod);
  const response = NextResponse.redirect(new URL("/giris", readAppUrl() ?? request.url), 303);
  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}
