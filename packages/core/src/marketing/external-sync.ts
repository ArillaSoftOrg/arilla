/**
 * İYS (İleti Yönetim Sistemi) entegrasyon SINIRI (docs/decisions/0046).
 *
 * Bugün İYS hesabı, marka kodu ve API erişimi YOK; bu dosya bir entegrasyon
 * iddia etmez. Yalnızca şunu sağlar:
 * - Her pazarlama rızası olayı (onay ve ret) adresle birlikte
 *   `consent_external_sync` içinde `pending` bekler.
 * - Gelecekteki bir senkron işi bekleyenleri `listPendingConsentSync` ile
 *   okur, sonucu `recordConsentSyncResult` ile yazar.
 * - Canlı gönderim kapısı `synced` olmayan rızayı kabul etmez
 *   (`policy.requireExternalSync`). Yerel iptal senkronu BEKLEMEZ.
 *
 * İYS'nin kaynak/izin türü kodları (ör. kaynak alanı) resmi dokümandan
 * doğrulanmadan buraya yazılmaz; eşleme entegrasyonla birlikte eklenir.
 */
import { consentExternalSync, type Database, userConsent } from "@arilla/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export type ExternalConsentProvider = "iys";

/** Kod tarafında bir İYS istemcisi yok; durum göstergesi (yönetim, sağlık). */
export const IYS_INTEGRATION_STATUS = "not_configured" as const;

export interface PendingConsentSync {
  consentId: number;
  email: string;
  granted: boolean;
  consentedAt: Date;
  source: string | null;
  textVersion: string | null;
  attempts: number;
}

export async function listPendingConsentSync(
  db: Database,
  provider: ExternalConsentProvider,
  limit = 100,
): Promise<PendingConsentSync[]> {
  const rows = await db
    .select({
      consentId: consentExternalSync.consentId,
      email: userConsent.email,
      granted: userConsent.granted,
      consentedAt: userConsent.grantedAt,
      source: userConsent.source,
      textVersion: userConsent.textVersion,
      attempts: consentExternalSync.attempts,
    })
    .from(consentExternalSync)
    .innerJoin(userConsent, eq(userConsent.id, consentExternalSync.consentId))
    .where(
      and(
        eq(consentExternalSync.provider, provider),
        inArray(consentExternalSync.status, ["pending", "failed"]),
      ),
    )
    // Onay ve ret olay sırasıyla gönderilmeli: eski bir onay yeni bir reddi ezmesin.
    .orderBy(asc(userConsent.grantedAt), asc(userConsent.id))
    .limit(Math.min(Math.max(limit, 1), 1000));
  return rows.flatMap((row) => (row.email ? [{ ...row, email: row.email }] : []));
}

export type ConsentSyncOutcome =
  | { ok: true; externalRef?: string }
  | { ok: false; errorCode: string };

export async function recordConsentSyncResult(
  db: Database,
  consentId: number,
  provider: ExternalConsentProvider,
  outcome: ConsentSyncOutcome,
): Promise<void> {
  const now = new Date();
  await db
    .update(consentExternalSync)
    .set(
      outcome.ok
        ? {
            status: "synced",
            syncedAt: now,
            lastErrorCode: null,
            externalRef: outcome.externalRef?.slice(0, 128) ?? null,
            attempts: sql`${consentExternalSync.attempts} + 1`,
            updatedAt: now,
          }
        : {
            status: "failed",
            // Sağlayıcı mesajı değil, yalnızca kısa kod (kişisel veri sızmasın).
            lastErrorCode: /^[A-Z0-9_]{1,32}$/.test(outcome.errorCode)
              ? outcome.errorCode
              : "EUNKNOWN",
            attempts: sql`${consentExternalSync.attempts} + 1`,
            updatedAt: now,
          },
    )
    .where(
      and(eq(consentExternalSync.consentId, consentId), eq(consentExternalSync.provider, provider)),
    );
}
