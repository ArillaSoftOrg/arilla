/**
 * KVKK m.11 "Görüntüleme" hakkı (docs/kvkk.md): "hakkımdaki verileri indir
 * (JSON)". `session`/`auth_token` içeriği (hash'ler) dahil değil - bunlar
 * güvenlik durumu, kullanıcıya anlamlı "hakkımdaki veri" değil.
 *
 * 0049: giriş/çıkış geçmişi, hesap özeti, rıza geçmişinin kaynağı/sürümü ve
 * rızalı analitik olayları da verilir. Oturum kimliği, tıklama kimliği, IP
 * ve ham user agent verilmez (iç güvenlik ayrıntısı).
 */

import {
  aiSearchCharge,
  alert,
  appUser,
  authEvent,
  bonusAccount,
  bonusLedger,
  chatMessage,
  click,
  conversation,
  type Database,
  earlyAccess,
  feedback,
  form,
  formAnswer,
  formQuestion,
  formQuestionOption,
  formResponse,
  marketingCampaign,
  marketingCampaignDelivery,
  product,
  productView,
  referral,
  savedItem,
  userActivityEvent,
  userActivitySummary,
  userConsent,
  userSizeProfile,
} from "@arilla/db";
import { asc, desc, eq } from "drizzle-orm";

export class UserNotFoundError extends Error {
  constructor() {
    super("kullanici bulunamadi");
    this.name = "UserNotFoundError";
  }
}

export interface UserDataExport {
  profile: {
    publicId: string;
    email: string | null;
    displayName: string | null;
    role: string;
    createdAt: Date;
    lastSeenAt: Date | null;
  };
  savedItems: Array<{ productId: number; productTitle: string; savedAt: Date }>;
  alerts: Array<{
    productId: number;
    productTitle: string;
    kind: string;
    targetPrice: number | null;
    sizeNorm: string | null;
    isActive: boolean;
    createdAt: Date;
  }>;
  history: Array<{ productId: number; productTitle: string; viewedAt: Date }>;
  sizeProfile: Array<{ categoryPath: string; sizeNorm: string }>;
  /** `source`/`textVersion` 0037 öncesi satırlarda `null` ("sürümsüz kayıt"); kayıt yine geçerlidir. */
  consents: Array<{
    kind: string;
    granted: boolean;
    grantedAt: Date;
    source: string | null;
    textVersion: string | null;
  }>;
  /** 0049: giriş/çıkış geçmişi (en fazla 1 yıl tutulur). */
  authHistory: Array<{
    kind: string;
    provider: string | null;
    deviceClass: string | null;
    browserFamily: string | null;
    countryCode: string | null;
    createdAt: Date;
  }>;
  /** 0049: hesap özeti; `null` sayaç = bilinmiyor. */
  activitySummary: {
    firstSignInAt: Date | null;
    lastSignInAt: Date | null;
    lastActiveAt: Date | null;
    signInCount: number | null;
    serviceCountersSince: Date | null;
    lastDeviceClass: string | null;
    lastBrowserFamily: string | null;
    lastCountryCode: string | null;
    searchCount: number | null;
    lastSearchAt: Date | null;
    productViewCount: number | null;
    merchantExitCount: number | null;
    analyticsCountersSince: Date | null;
  } | null;
  /** 0049: yalnızca analitik rızasıyla yazılan olaylar (en fazla 180 gün). */
  activityEvents: Array<{
    kind: string;
    productId: number | null;
    offerId: number | null;
    queryNorm: string | null;
    resultCount: number | null;
    createdAt: Date;
  }>;
  clicks: Array<{
    offerId: number;
    channel: string;
    surface: string | null;
    priceAtClickKurus: number | null;
    createdAt: Date;
  }>;
  /** Erken erişim listesi kaydı (0031); listede değilse `null`. */
  earlyAccess: { status: string; joinedAt: Date } | null;
  /** Arama hakları (0047): bonus bakiye, harcamalar, bonus defteri, davetler. */
  searchRights: {
    referralCode: string | null;
    bonusBalance: number;
    searches: Array<{
      operation: string;
      state: string;
      day: string;
      fromDaily: number;
      fromBonus: number;
      createdAt: Date;
    }>;
    bonusLedger: Array<{ reason: string; delta: number; balanceAfter: number; createdAt: Date }>;
    /** Bu hesabin davet edilme kaydi; davet edenin kimligi disa verilmez. */
    invitedBy: { status: string; createdAt: Date } | null;
    invitesSent: Array<{ status: string; createdAt: Date; qualifiedAt: Date | null }>;
  };
  /**
   * Bu hesaba yönelik pazarlama e-postası teslimleri (0035). `state = sent`
   * sağlayıcının kabul ettiği anlamına gelir. İptal token özeti verilmez.
   */
  marketingEmails: Array<{ subject: string; state: string; sentAt: Date | null; createdAt: Date }>;
  /** `/geri-bildirim` ile hesapla gönderilen geri bildirimler (0032). */
  /** Form / anket yanıtları (0043); çoklu seçimde cevaplar virgülle birleşir. */
  surveyResponses: Array<{
    formTitle: string;
    submittedAt: Date;
    answers: Array<{ question: string; answer: string }>;
  }>;
  /** Geri bildirim (`kind = feedback`) ve iletisim formu (`kind = contact`) gonderileri. */
  feedback: Array<{
    kind: string;
    name: string | null;
    email: string | null;
    category: string;
    title: string;
    message: string;
    priority: string | null;
    status: string;
    createdAt: Date;
  }>;
  /** Konuşmalı keşif (0054, karar 0074): sohbetler ve kullanıcının/asistanın mesajları. */
  conversations: Array<{
    publicId: string;
    title: string;
    createdAt: Date;
    lastMessageAt: Date;
    messages: Array<{ seq: number; role: string; kind: string; content: string; createdAt: Date }>;
  }>;
}

export async function exportUserData(db: Database, userId: number): Promise<UserDataExport> {
  const userRows = await db.select().from(appUser).where(eq(appUser.id, userId)).limit(1);
  const user = userRows[0];
  if (!user) {
    throw new UserNotFoundError();
  }

  const [savedRows, alertRows, historyRows, sizeRows, consentRows, clickRows, earlyRows] =
    await Promise.all([
      db
        .select({
          productId: savedItem.productId,
          productTitle: product.title,
          savedAt: savedItem.createdAt,
        })
        .from(savedItem)
        .innerJoin(product, eq(product.id, savedItem.productId))
        .where(eq(savedItem.userId, userId)),
      db
        .select({
          productId: alert.productId,
          productTitle: product.title,
          kind: alert.kind,
          targetPrice: alert.targetPrice,
          sizeNorm: alert.sizeNorm,
          isActive: alert.isActive,
          createdAt: alert.createdAt,
        })
        .from(alert)
        .innerJoin(product, eq(product.id, alert.productId))
        .where(eq(alert.userId, userId)),
      db
        .select({
          productId: productView.productId,
          productTitle: product.title,
          viewedAt: productView.viewedAt,
        })
        .from(productView)
        .innerJoin(product, eq(product.id, productView.productId))
        .where(eq(productView.userId, userId))
        .orderBy(desc(productView.viewedAt)),
      db
        .select({ categoryPath: userSizeProfile.categoryPath, sizeNorm: userSizeProfile.sizeNorm })
        .from(userSizeProfile)
        .where(eq(userSizeProfile.userId, userId)),
      db
        .select({
          kind: userConsent.kind,
          granted: userConsent.granted,
          grantedAt: userConsent.grantedAt,
          source: userConsent.source,
          textVersion: userConsent.textVersion,
        })
        .from(userConsent)
        .where(eq(userConsent.userId, userId))
        .orderBy(desc(userConsent.grantedAt), desc(userConsent.id)),
      db
        .select({
          offerId: click.offerId,
          channel: click.channel,
          surface: click.surface,
          priceAtClickKurus: click.priceAtClick,
          createdAt: click.createdAt,
        })
        .from(click)
        .where(eq(click.userId, userId))
        .orderBy(desc(click.createdAt)),
      db
        .select({ status: earlyAccess.status, joinedAt: earlyAccess.createdAt })
        .from(earlyAccess)
        .where(eq(earlyAccess.userId, userId))
        .limit(1),
    ]);

  const [authRows, summaryRows, activityRows] = await Promise.all([
    db
      .select({
        kind: authEvent.kind,
        provider: authEvent.provider,
        deviceClass: authEvent.deviceClass,
        browserFamily: authEvent.browserFamily,
        countryCode: authEvent.countryCode,
        createdAt: authEvent.createdAt,
      })
      .from(authEvent)
      .where(eq(authEvent.userId, userId))
      .orderBy(desc(authEvent.createdAt), desc(authEvent.id)),
    db
      .select({
        firstSignInAt: userActivitySummary.firstSignInAt,
        lastSignInAt: userActivitySummary.lastSignInAt,
        lastActiveAt: userActivitySummary.lastActiveAt,
        signInCount: userActivitySummary.signInCount,
        serviceCountersSince: userActivitySummary.serviceCountersSince,
        lastDeviceClass: userActivitySummary.lastDeviceClass,
        lastBrowserFamily: userActivitySummary.lastBrowserFamily,
        lastCountryCode: userActivitySummary.lastCountryCode,
        searchCount: userActivitySummary.searchCount,
        lastSearchAt: userActivitySummary.lastSearchAt,
        productViewCount: userActivitySummary.productViewCount,
        merchantExitCount: userActivitySummary.merchantExitCount,
        analyticsCountersSince: userActivitySummary.analyticsCountersSince,
      })
      .from(userActivitySummary)
      .where(eq(userActivitySummary.userId, userId))
      .limit(1),
    db
      .select({
        kind: userActivityEvent.kind,
        productId: userActivityEvent.productId,
        offerId: userActivityEvent.offerId,
        queryNorm: userActivityEvent.queryNorm,
        resultCount: userActivityEvent.resultCount,
        createdAt: userActivityEvent.createdAt,
      })
      .from(userActivityEvent)
      .where(eq(userActivityEvent.userId, userId))
      .orderBy(desc(userActivityEvent.createdAt), desc(userActivityEvent.id)),
  ]);

  const marketingRows = await db
    .select({
      subject: marketingCampaign.subject,
      state: marketingCampaignDelivery.state,
      sentAt: marketingCampaignDelivery.sentAt,
      createdAt: marketingCampaignDelivery.createdAt,
    })
    .from(marketingCampaignDelivery)
    .innerJoin(marketingCampaign, eq(marketingCampaign.id, marketingCampaignDelivery.campaignId))
    .where(eq(marketingCampaignDelivery.userId, userId))
    .orderBy(desc(marketingCampaignDelivery.createdAt));

  const surveyRows = await db
    .select({
      responseId: formResponse.id,
      formTitle: form.title,
      submittedAt: formResponse.submittedAt,
      question: formQuestion.label,
      option: formQuestionOption.label,
      text: formAnswer.textValue,
    })
    .from(formResponse)
    .innerJoin(form, eq(form.id, formResponse.formId))
    .innerJoin(formAnswer, eq(formAnswer.responseId, formResponse.id))
    .innerJoin(formQuestion, eq(formQuestion.id, formAnswer.questionId))
    .leftJoin(formQuestionOption, eq(formQuestionOption.id, formAnswer.optionId))
    .where(eq(formResponse.userId, userId))
    .orderBy(
      desc(formResponse.submittedAt),
      desc(formResponse.id),
      asc(formQuestion.sortOrder),
      asc(formQuestionOption.sortOrder),
    );
  const surveyResponses: UserDataExport["surveyResponses"] = [];
  const surveyIndex = new Map<number, UserDataExport["surveyResponses"][number]>();
  for (const row of surveyRows) {
    let response = surveyIndex.get(row.responseId);
    if (!response) {
      response = { formTitle: row.formTitle, submittedAt: row.submittedAt, answers: [] };
      surveyIndex.set(row.responseId, response);
      surveyResponses.push(response);
    }
    const value = row.option ?? row.text ?? "";
    const last = response.answers[response.answers.length - 1];
    if (last && last.question === row.question && row.option !== null) {
      last.answer = `${last.answer}, ${value}`;
    } else {
      response.answers.push({ question: row.question, answer: value });
    }
  }

  const feedbackRows = await db
    .select({
      kind: feedback.kind,
      name: feedback.name,
      email: feedback.email,
      category: feedback.category,
      title: feedback.title,
      message: feedback.message,
      priority: feedback.priority,
      status: feedback.status,
      createdAt: feedback.createdAt,
    })
    .from(feedback)
    .where(eq(feedback.userId, userId))
    .orderBy(desc(feedback.createdAt));

  const [bonusRows, chargeRows, ledgerRows, invitedByRows, invitesSentRows] = await Promise.all([
    db
      .select({ balance: bonusAccount.balance })
      .from(bonusAccount)
      .where(eq(bonusAccount.userId, userId))
      .limit(1),
    db
      .select({
        operation: aiSearchCharge.operation,
        state: aiSearchCharge.state,
        day: aiSearchCharge.day,
        fromDaily: aiSearchCharge.fromDaily,
        fromBonus: aiSearchCharge.fromBonus,
        createdAt: aiSearchCharge.createdAt,
      })
      .from(aiSearchCharge)
      .where(eq(aiSearchCharge.userId, userId))
      .orderBy(desc(aiSearchCharge.createdAt)),
    db
      .select({
        reason: bonusLedger.reason,
        delta: bonusLedger.delta,
        balanceAfter: bonusLedger.balanceAfter,
        createdAt: bonusLedger.createdAt,
      })
      .from(bonusLedger)
      .where(eq(bonusLedger.userId, userId))
      .orderBy(desc(bonusLedger.createdAt), desc(bonusLedger.id)),
    db
      .select({ status: referral.status, createdAt: referral.createdAt })
      .from(referral)
      .where(eq(referral.inviteeUserId, userId))
      .limit(1),
    db
      .select({
        status: referral.status,
        createdAt: referral.createdAt,
        qualifiedAt: referral.qualifiedAt,
      })
      .from(referral)
      .where(eq(referral.inviterUserId, userId))
      .orderBy(desc(referral.createdAt)),
  ]);

  return {
    profile: {
      publicId: user.publicId,
      email: user.email,
      displayName: user.displayName,
      role: user.role,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
    },
    savedItems: savedRows,
    alerts: alertRows,
    history: historyRows,
    sizeProfile: sizeRows,
    consents: consentRows,
    authHistory: authRows,
    activitySummary: summaryRows[0] ?? null,
    activityEvents: activityRows,
    clicks: clickRows,
    earlyAccess: earlyRows[0] ?? null,
    searchRights: {
      referralCode: user.referralCode,
      bonusBalance: bonusRows[0]?.balance ?? 0,
      searches: chargeRows,
      bonusLedger: ledgerRows,
      invitedBy: invitedByRows[0] ?? null,
      invitesSent: invitesSentRows,
    },
    marketingEmails: marketingRows,
    surveyResponses,
    feedback: feedbackRows,
    conversations: await exportConversationsSafely(db, userId),
  };
}

/**
 * 0054 henüz uygulanmamış bir veritabanında (kod migration'dan önce dağıtılırsa)
 * tablo yoktur, dolayısıyla sohbet verisi de yoktur: dışa aktarım kırılmaz.
 * Başka her hata yukarı çıkar.
 */
async function exportConversationsSafely(
  db: Database,
  userId: number,
): Promise<UserDataExport["conversations"]> {
  try {
    return await exportConversations(db, userId);
  } catch (error) {
    const code =
      (error as { cause?: { code?: string } } | null)?.cause?.code ??
      (error as { code?: string } | null)?.code;
    if (code === "42P01") return [];
    throw error;
  }
}

async function exportConversations(
  db: Database,
  userId: number,
): Promise<UserDataExport["conversations"]> {
  const chats = await db
    .select()
    .from(conversation)
    .where(eq(conversation.userId, userId))
    .orderBy(asc(conversation.createdAt));
  const out: UserDataExport["conversations"] = [];
  for (const chat of chats) {
    const rows = await db
      .select()
      .from(chatMessage)
      .where(eq(chatMessage.conversationId, chat.id))
      .orderBy(asc(chatMessage.seq));
    out.push({
      publicId: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      lastMessageAt: chat.lastMessageAt,
      messages: rows.map((m) => ({
        seq: m.seq,
        role: m.role,
        kind: m.kind,
        content: m.content,
        createdAt: m.createdAt,
      })),
    });
  }
  return out;
}
