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
 * - `auth_token`: `app_user`'a FK ile bağlı değil (yalnızca e-posta), ama
 *   aynı e-postaya ait tüketilmemiş bir token'ın silme sonrası hesabı
 *   sessizce yeniden açmasını önlemek için hijyen amacıyla temizlenir.
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
import { and, eq, inArray } from "drizzle-orm";

export async function deleteAccount(db: Database, userId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const userRows = await tx
      .select({ email: appUser.email })
      .from(appUser)
      .where(eq(appUser.id, userId))
      .limit(1);
    const user = userRows[0];
    if (!user) return;

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

    if (user.email) {
      await tx.delete(authToken).where(eq(authToken.email, user.email));
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
