/**
 * docs/backlog.md E3: "hesap silme (click kayıtları kimliksizleştirilir)".
 * docs/kvkk.md: silme gerçek olmalı; `click`/`conversion` mali mevzuat
 * gereği kalır ama `user_id` NULL'a çekilir (conversion zaten `click`
 * üzerinden dolaylı bağlı, ayrı işlem gerekmez).
 *
 * `session`, `product_view`, `user_size_profile`, `user_consent` şemada
 * `ON DELETE CASCADE` taşıyor - `app_user` silinince otomatik gider, burada
 * ayrıca dokunulmaz. Geri kalan tablolarda CASCADE YOK (kısıt ihlali
 * olmaması için burada açıkça temizlenir):
 *
 * - `creator` (varsa): `collection` → `collection_item` CASCADE'i tetikler,
 *   ama `collection`, `creator_affiliate_account`, `follow` (bu creator'ı
 *   takip edenler) `creator` silinmeden önce elle temizlenir.
 * - `follow` (bu kullanıcının kendi takipleri), `saved_item`, `alert`: silinir.
 * - `click`, `api_usage`, `image_upload`, `link_resolution_request`:
 *   nullable `user_id` - SET NULL (kimliksizleştirme, silme değil).
 * - Arama hakkı (0034, docs/decisions/0047): `ai_quota_day`, `bonus_account`,
 *   `ai_search_charge`, `bonus_ledger` ve kullanıcının davet edilen olarak
 *   `referral` satırı `ON DELETE CASCADE` ile gider (append-only defterin
 *   CASCADE'i tablo sahibi yetkisiyle çalışır). Davet ettiği kişilerin
 *   satırındaki `inviter_user_id` NULL'a çekilir. Sağlayıcı kimliğinin özeti
 *   tutulmaz; burada ayrıca bir şey yapılmaz.
 * - Kullanıcı aktivitesi (0036, docs/decisions/0049): `auth_event`,
 *   `user_activity_event` ve `user_activity_summary` `ON DELETE CASCADE` ile
 *   gider. Yeni oturum kolonları `session` ile birlikte gider. Rıza geçmişi
 *   (`user_consent`, 0037 kolonları dahil) zaten CASCADE. Denetim kaydında
 *   (`admin_audit_event`) yalnızca sayısal hedef kimliği kalır, kişisel veri
 *   yoktur. Burada ayrıca bir şey yapılmaz.
 * - `auth_token`: `app_user`'a FK ile bağlı değil (yalnızca e-posta), ama
 *   aynı e-postaya ait tüketilmemiş bir token'ın silme sonrası hesabı
 *   sessizce yeniden açmasını önlemek için hijyen amacıyla temizlenir.
 *   Hesabın e-postası VE bağlı giriş kimliklerinin (Google/Apple)
 *   e-postaları, harf duyarsız.
 *
 * Yetkili hesap (karar 0050): moderatör/yönetici kendi hesabını SİLEMEZ
 * (`StaffAccountDeletionError`). Önce rolü düşürülür (veritabanı
 * tetikleyicisiyle denetlenir, docs/ops.md). Böylece çalınmış bir yönetici
 * oturumu hesabı silip izini kaybettiremez. Rolü düşürülmüş eski personel
 * silinebilir: denetim satırları kalır, yalnızca aktör bağlantısı NULL olur
 * (`admin_audit_event`/`match_candidate.reviewed_by` ON DELETE SET NULL, 0039).
 * Oturumlar (`session`) ve giriş kimlikleri (`user_identity`) CASCADE ile
 * aynı işlemde gider; silinen hesabın çerezi bir sonraki istekte geçersizdir.
 */

import {
  alert,
  apiUsage,
  appUser,
  authToken,
  click,
  collection,
  creator,
  creatorAffiliateAccount,
  type Database,
  follow,
  imageUpload,
  linkResolutionRequest,
  phoneLoginCode,
  savedItem,
  userIdentity,
} from "@arilla/db";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { hasCapability } from "../admin/capabilities.ts";

export class StaffAccountDeletionError extends Error {
  constructor() {
    super("yetkili hesap silinemez; once rol dusurulmeli");
    this.name = "StaffAccountDeletionError";
  }
}

export async function deleteAccount(db: Database, userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const userRows = await tx
      .select({ email: appUser.email, role: appUser.role })
      .from(appUser)
      .where(eq(appUser.id, userId))
      .limit(1);
    const user = userRows[0];
    if (!user) return;
    if (hasCapability(user.role, "admin.access")) throw new StaffAccountDeletionError();

    const creatorRows = await tx
      .select({ id: creator.id })
      .from(creator)
      .where(eq(creator.userId, userId))
      .limit(1);
    const creatorRow = creatorRows[0];
    if (creatorRow) {
      await tx.delete(collection).where(eq(collection.creatorId, creatorRow.id));
      await tx
        .delete(creatorAffiliateAccount)
        .where(eq(creatorAffiliateAccount.creatorId, creatorRow.id));
      await tx.delete(follow).where(eq(follow.creatorId, creatorRow.id));
      await tx.delete(creator).where(eq(creator.id, creatorRow.id));
    }

    await tx.delete(follow).where(eq(follow.userId, userId));
    await tx.delete(savedItem).where(eq(savedItem.userId, userId));
    await tx.delete(alert).where(eq(alert.userId, userId));

    await tx.update(click).set({ userId: null }).where(eq(click.userId, userId));
    await tx.update(apiUsage).set({ userId: null }).where(eq(apiUsage.userId, userId));
    await tx.update(imageUpload).set({ userId: null }).where(eq(imageUpload.userId, userId));
    await tx
      .update(linkResolutionRequest)
      .set({ userId: null })
      .where(eq(linkResolutionRequest.userId, userId));

    const identityEmails = await tx
      .select({ email: userIdentity.email })
      .from(userIdentity)
      .where(and(eq(userIdentity.userId, userId), isNotNull(userIdentity.email)));
    const loginEmails = [
      ...new Set(
        [user.email, ...identityEmails.map((row) => row.email)]
          .filter((email): email is string => Boolean(email))
          .map((email) => email.toLowerCase()),
      ),
    ];
    if (loginEmails.length > 0) {
      await tx.delete(authToken).where(inArray(sql`lower(${authToken.email})`, loginEmails));
    }
    // 0025: telefon kodlari numarayi tasir; kullanicinin telefon kimlikleriyle
    // birlikte silinir (user_identity app_user ile CASCADE gider).
    await tx.delete(phoneLoginCode).where(
      inArray(
        phoneLoginCode.phone,
        tx
          .select({ phone: userIdentity.providerSubject })
          .from(userIdentity)
          .where(and(eq(userIdentity.userId, userId), eq(userIdentity.provider, "phone"))),
      ),
    );
    await tx.delete(appUser).where(eq(appUser.id, userId));
  });
}
