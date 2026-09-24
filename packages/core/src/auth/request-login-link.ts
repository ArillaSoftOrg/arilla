/**
 * decision 0006: oran siniri kontrolu -> `auth_token` INSERT -> e-posta
 * gonderimi. `app_user` tablosuna burada DOKUNULMAZ - hesabin var olup
 * olmadigi bu asamada hicbir sekilde sizdirilmaz (copy.md `auth.rate_limited`
 * notu: "hesabin var olup olmadigini belli etmez").
 */
import { authToken, type Database } from "@arilla/db";
import { requireAppUrl } from "../config/app-url.ts";
import { checkAuthRateLimit, releaseEmailRateLimit } from "./rate-limit.ts";
import { sendLoginEmail } from "./send-login-email.ts";
import { generateRawToken, hashToken } from "./token.ts";
import type { RequestLoginLinkInput, RequestLoginLinkResult } from "./types.ts";

export async function requestLoginLink(
  db: Database,
  input: RequestLoginLinkInput,
): Promise<RequestLoginLinkResult> {
  // Yapilandirma hatasi (APP_URL) token yazilmadan ve oran hakki harcanmadan
  // once yakalanir.
  const appUrl = requireAppUrl();

  await checkAuthRateLimit({ email: input.email, ip: input.ip });

  const rawToken = generateRawToken();
  // Modul yuklenirken degil, cagri aninda okunur - `getDatabase()`'deki
  // gibi (packages/db/src/client.ts): testlerde .env `loadDotEnv()` ile geç
  // yuklenir, modul-seviyesi sabit bu durumda hep varsayilana duserdi.
  const ttlMinutes = Number(process.env.AUTH_TOKEN_TTL_MINUTES ?? 15);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const inserted = await db
    .insert(authToken)
    .values({
      email: input.email,
      tokenHash: hashToken(rawToken),
      expiresAt,
      requestIp: input.ip,
    })
    .returning({ id: authToken.id });

  const authTokenId = inserted[0]?.id;
  if (authTokenId === undefined) {
    throw new Error("auth_token insert bos sonuc dondurdu");
  }

  const loginUrl = `${appUrl}/giris/dogrula?token=${rawToken}`;

  try {
    await sendLoginEmail({ email: input.email, loginUrl });
  } catch (error) {
    // Gonderilemeyen baglanti icin e-posta hakki geri verilir; tekrar deneme
    // "az once gonderdik" yanitiyla karsilasmaz (sessiz basari yok).
    await releaseEmailRateLimit(input.email);
    throw error;
  }

  return { authTokenId };
}
