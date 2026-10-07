/**
 * `/yonetim/kullanicilar` (Faz 6): SALT OKUNUR kullanıcı bulma. Yalnızca
 * yönetici (`users.read`).
 *
 * - Kısmi arama (`searchUsers`): ad ve e-posta içinde, Türkçe katlamalı,
 *   sınırlı ve sayfalı; tam hesap kimliği ve (uyumluluk için) E.164 telefon
 *   tam eşleşmeyle. Tüm tablo istemciye gönderilmez.
 * - Rol düzenleme, hesap silme, kimliğe bürünme YOK (docs/decisions/0039).
 * - Her arama ve her ayrıntı görüntüleme denetim kaydına yazılır. Aranan
 *   değer (e-posta/telefon) kayda YAZILMAZ; yalnızca yöntem ve bulunan hesap.
 * - Görünen iletişim bilgisi maskelidir; oturum token'ı, kimlik sağlayıcı
 *   `subject`'i, IP gösterilmez.
 */
import {
  alert,
  appUser,
  creator,
  type Database,
  savedItem,
  session,
  userConsent,
  userIdentity,
} from "@arilla/db";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import { CONSENT_KINDS } from "../account/consent.ts";
import type { ConsentKind } from "../account/types.ts";
import { type EntitlementStatus, getEntitlementStatus } from "../entitlement/status.ts";
import { foldedTextExpr, foldForMatch } from "../search/text-match.ts";
import { maskEmail, recordAdminEvent } from "./audit.ts";
import { type AdminActor, assertCapability } from "./capabilities.ts";

export type UserLookupMethod = "email" | "phone" | "public_id";

export class UserLookupInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserLookupInputError";
  }
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{1,63}$/;
const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Girdinin türünü belirler ve normalleştirir; tanınmazsa hata. */
export function parseUserLookup(raw: string): { method: UserLookupMethod; value: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0 || value.length > 254) {
    throw new UserLookupInputError("E-posta, telefon (+90…) ya da hesap kimliği gir.");
  }
  if (UUID.test(value)) return { method: "public_id", value: value.toLowerCase() };
  if (EMAIL.test(value)) return { method: "email", value: value.toLowerCase() };
  const phone = value.replace(/[\s()-]/g, "");
  if (E164.test(phone)) return { method: "phone", value: phone };
  throw new UserLookupInputError("E-posta, telefon (+90…) ya da hesap kimliği gir.");
}

/** `+905321234567` → `+90 ••• ••• ••67`. */
export function maskPhoneForAdmin(phone: string | null): string | null {
  if (!phone) return null;
  const country = phone.startsWith("+90") ? "+90" : phone.slice(0, 3);
  return `${country} ••• ••• ••${phone.slice(-2)}`;
}

/**
 * Tam eşleşmeyle hesap arar. Sonuç yalnızca `publicId` (ayrıntı sayfası
 * adresi); arama denetime yazılır — bulunamadıysa da (tarama girişimi görünür).
 */
export async function lookupUser(
  db: Database,
  actor: AdminActor,
  raw: string,
): Promise<{ publicId: string | null; method: UserLookupMethod }> {
  assertCapability(actor, "users.read");
  const { method, value } = parseUserLookup(raw);

  return db.transaction(async (tx) => {
    let found: { id: number; publicId: string } | undefined;
    if (method === "public_id") {
      found = (
        await tx
          .select({ id: appUser.id, publicId: appUser.publicId })
          .from(appUser)
          .where(eq(appUser.publicId, value))
          .limit(1)
      )[0];
    } else if (method === "email") {
      found =
        (
          await tx
            .select({ id: appUser.id, publicId: appUser.publicId })
            .from(appUser)
            .where(eq(appUser.email, value))
            .limit(1)
        )[0] ??
        (
          await tx
            .select({ id: appUser.id, publicId: appUser.publicId })
            .from(userIdentity)
            .innerJoin(appUser, eq(appUser.id, userIdentity.userId))
            .where(eq(sql`lower(${userIdentity.email})`, value))
            .limit(1)
        )[0];
    } else {
      found = (
        await tx
          .select({ id: appUser.id, publicId: appUser.publicId })
          .from(userIdentity)
          .innerJoin(appUser, eq(appUser.id, userIdentity.userId))
          .where(and(eq(userIdentity.provider, "phone"), eq(userIdentity.providerSubject, value)))
          .limit(1)
      )[0];
    }

    await recordAdminEvent(tx, {
      actor,
      action: "users.lookup",
      targetType: "app_user",
      targetId: found ? found.id : "-",
      after: { method, found: Boolean(found) },
    });
    return { publicId: found?.publicId ?? null, method };
  });
}

/** Kısmi metin araması için en az karakter (katlanmış). Tam kimlik bu kuraldan muaf. */
export const USER_SEARCH_MIN_LENGTH = 2;
export const USER_SEARCH_MAX_LENGTH = 100;
export const USER_SEARCH_PAGE_SIZE = 20;
/** Ofset sayfalaması: çok derin sayfa istenmez. */
const USER_SEARCH_MAX_PAGE = 50;
/** Arama sorgusunun en uzun süresi (yönetim ekranı; 2 karakterlik aramalar indekssiz taranır). */
const USER_SEARCH_TIMEOUT_MS = 5_000;
/** pg_trgm üçlü karakter kullanır: daha kısa terimde indeks yardım etmez. */
const TRIGRAM_MIN_LENGTH = 3;

export type UserSearchMethod = "text" | "public_id" | "phone";

export interface UserSearchRow {
  publicId: string;
  /** Google/Apple'dan gelen ad; yoksa null. */
  displayName: string | null;
  emailMasked: string | null;
  /** Yalnızca telefon kimliği varsa (bugün aktif giriş yolu değil). */
  phoneMasked: string | null;
  role: string;
  createdAt: Date;
  earlyAccess: { status: string; joinedAt: Date } | null;
}

export interface UserSearchResult {
  method: UserSearchMethod;
  rows: UserSearchRow[];
  page: number;
  hasNext: boolean;
}

/** LIKE özel karakterleri (`%`, `_`, `\`) düz metin olarak aranır. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function classifySearch(raw: string): { method: UserSearchMethod; value: string } {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (value.length === 0) throw new UserLookupInputError("Aramak için bir şey yaz.");
  if (value.length > USER_SEARCH_MAX_LENGTH) {
    throw new UserLookupInputError(`En fazla ${USER_SEARCH_MAX_LENGTH} karakter.`);
  }
  if (UUID.test(value)) return { method: "public_id", value: value.toLowerCase() };
  const phone = value.replace(/[\s()-]/g, "");
  if (E164.test(phone)) return { method: "phone", value: phone };
  const folded = foldForMatch(value);
  if (folded.length < USER_SEARCH_MIN_LENGTH) {
    throw new UserLookupInputError(`En az ${USER_SEARCH_MIN_LENGTH} karakter yaz.`);
  }
  return { method: "text", value: folded };
}

/**
 * Kısmi kullanıcı araması. Metin: ad (`app_user.display_name` ve giriş
 * kimliğindeki ad) ya da e-posta (`app_user.email` ve kimlikteki e-posta)
 * İÇİNDE, büyük/küçük harf ve Türkçe karakter duyarsız. Tam hesap kimliği ve
 * E.164 telefon tam eşleşme. En yeni hesap önce, sayfa başına 20.
 *
 * Katlanmış ad/e-posta üzerinde trigram indeksleri vardır (migration 0038).
 * Yerel 200 bin kullanıcı / 140 bin kimlikte EXPLAIN ANALYZE (karar 0055):
 * seyrek terim ~700 ms → 2-3 ms, eşleşmeyen terim ~650 ms → 0,1 ms, ad
 * ~25 ms → ~30 ms, çok yaygın terim ("gmail") ~110 ms → ~330-440 ms. 2
 * karakterlik terim trigram kullanamaz; UNION biçimi orada 3 kat yavaşladığı
 * için eski OR biçimiyle (~430 ms) taranır. Süre `statement_timeout` ile
 * sınırlıdır.
 *
 * Arama denetime yazılır: yöntem, sayfa ve sonuç sayısı. Aranan değer
 * (ad, e-posta, telefon) YAZILMAZ.
 *
 * Sınırlar karar 0049 §1a'dadır; gevşetmeden önce o dosya güncellenir.
 * Sonuç satırında tam e-posta/telefon, IP, oturum, rıza ve aktivite verisi
 * YOKTUR: e-posta ve telefon yalnızca maskelenmek için okunur. Tam değer
 * yalnızca `revealUserContact` (ayrı yetenek + taze giriş) ile açılır.
 * Sayfalama bilerek offset'tir (P0); keyset geçişi ayrı iştir.
 */
export async function searchUsers(
  db: Database,
  actor: AdminActor,
  raw: string,
  options: { page?: number } = {},
): Promise<UserSearchResult> {
  assertCapability(actor, "users.read");
  const { method, value } = classifySearch(raw);
  const requested = Math.trunc(Number(options.page ?? 1));
  const page = Number.isFinite(requested)
    ? Math.min(Math.max(1, requested), USER_SEARCH_MAX_PAGE)
    : 1;

  let where: ReturnType<typeof sql>;
  if (method === "public_id") {
    where = sql`u.public_id = ${value}::uuid`;
  } else if (method === "phone") {
    where = sql`EXISTS (SELECT 1 FROM user_identity i
                         WHERE i.user_id = u.id AND i.provider = 'phone'
                           AND i.provider_subject = ${value})`;
  } else {
    const pattern = `%${escapeLike(value)}%`;
    where =
      value.length >= TRIGRAM_MIN_LENGTH
        ? // Dört indeks dostu alt sorgunun birleşimi (0038 trigram indeksleri):
          // OR + EXISTS biçimi planlayıcının indeksi kullanmasını engelliyordu.
          sql`u.id IN (
      SELECT a.id FROM app_user a WHERE ${foldedTextExpr(sql`a.display_name`)} LIKE ${pattern}
      UNION SELECT a.id FROM app_user a WHERE ${foldedTextExpr(sql`a.email`)} LIKE ${pattern}
      UNION SELECT i.user_id FROM user_identity i WHERE ${foldedTextExpr(sql`i.email`)} LIKE ${pattern}
      UNION SELECT i.user_id FROM user_identity i WHERE ${foldedTextExpr(sql`i.display_name`)} LIKE ${pattern}
    )`
        : // Trigram yok: tek tarama, en yeni hesaptan sıralı erken çıkış.
          sql`(
      ${foldedTextExpr(sql`u.display_name`)} LIKE ${pattern}
      OR ${foldedTextExpr(sql`u.email`)} LIKE ${pattern}
      OR EXISTS (SELECT 1 FROM user_identity i
                  WHERE i.user_id = u.id
                    AND (${foldedTextExpr(sql`i.email`)} LIKE ${pattern}
                         OR ${foldedTextExpr(sql`i.display_name`)} LIKE ${pattern}))
    )`;
  }

  return db.transaction(async (tx) => {
    // Kısa ya da çok yaygın terimler binlerce satır eşler; süre sınırlı.
    await tx.execute(sql.raw(`SET LOCAL statement_timeout = ${USER_SEARCH_TIMEOUT_MS}`));
    const result = await tx.execute(sql`
      SELECT u.public_id, u.display_name, u.email, u.role, u.created_at,
             ea.status AS ea_status, ea.created_at AS ea_created_at,
             (SELECT i.provider_subject FROM user_identity i
               WHERE i.user_id = u.id AND i.provider = 'phone' LIMIT 1) AS phone
        FROM app_user u
        LEFT JOIN early_access ea ON ea.user_id = u.id
       WHERE ${where}
       ORDER BY u.created_at DESC, u.id DESC
       LIMIT ${USER_SEARCH_PAGE_SIZE + 1} OFFSET ${(page - 1) * USER_SEARCH_PAGE_SIZE}
    `);
    const fetched = result.rows as {
      public_id: string;
      display_name: string | null;
      email: string | null;
      role: string;
      created_at: string | Date;
      ea_status: string | null;
      ea_created_at: string | Date | null;
      phone: string | null;
    }[];
    const rows = fetched.slice(0, USER_SEARCH_PAGE_SIZE).map((row) => ({
      publicId: row.public_id,
      displayName: row.display_name,
      emailMasked: maskEmail(row.email),
      phoneMasked: maskPhoneForAdmin(row.phone),
      role: row.role,
      createdAt: new Date(row.created_at),
      earlyAccess:
        row.ea_status && row.ea_created_at
          ? { status: row.ea_status, joinedAt: new Date(row.ea_created_at) }
          : null,
    }));

    await recordAdminEvent(tx, {
      actor,
      action: "users.search",
      targetType: "app_user",
      targetId: "-",
      after: { method, page, results: rows.length },
    });

    return { method, rows, page, hasNext: fetched.length > USER_SEARCH_PAGE_SIZE };
  });
}

/** Bir rıza türünün son durumu; kayıt yoksa `null` (hiç sorulmadı/verilmedi). */
export interface ConsentView {
  kind: ConsentKind;
  latest: { granted: boolean; at: Date } | null;
}

export interface EntitlementChargeRow {
  operation: string;
  state: string;
  cost: number;
  fromDaily: number;
  fromBonus: number;
  refundReason: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}

export interface BonusLedgerRow {
  reason: string;
  delta: number;
  balanceAfter: number;
  createdAt: Date;
}

export interface UserEntitlementView {
  /** Hak motorunun kendi okuması (`getEntitlementStatus`); burada yeniden hesaplanmaz. */
  status: EntitlementStatus;
  /** Bonus defterinin neden bazında toplamları (append-only defterden). */
  ledgerTotals: { reason: string; total: number; entries: number }[];
  /** Pahalı aramaların durum bazında sayısı ve harcanan hak. */
  chargeTotals: { state: string; count: number; cost: number }[];
  recentCharges: EntitlementChargeRow[];
  recentLedger: BonusLedgerRow[];
}

export interface UserReferralView {
  /** Henüz üretilmemişse `null`: yönetim görüntülemesi kod ÜRETMEZ. */
  code: string | null;
  invitesPending: number;
  invitesQualified: number;
  /** `referral_inviter` ödüllerinin toplamı (tavan kırpması sonrası). */
  rewardsEarned: number;
  /** Bu hesap bir davetle mi geldi; davet edenin kimliği gösterilmez. */
  invitedBy: { status: string; at: Date } | null;
}

export const USER_DETAIL_HISTORY_LIMIT = 15;

export interface UserDetail {
  id: number;
  publicId: string;
  displayName: string | null;
  /**
   * Sağlayıcıdan gelen profil fotoğrafı adresi. Yönetim arayüzü bu adresi
   * YÜKLEMEZ (üçüncü taraf istek, CLAUDE.md); yalnızca var/yok gösterir.
   */
  avatarUrl: string | null;
  emailMasked: string | null;
  emailVerified: boolean;
  phoneMasked: string | null;
  role: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  identities: {
    provider: string;
    emailVerified: boolean;
    createdAt: Date;
    lastSeenAt: Date;
  }[];
  activeSessions: number;
  savedItems: number;
  alerts: { active: number; total: number };
  creatorHandle: string | null;
  /** Her bilinen rıza türü, kayıt yoksa da (`latest: null`). */
  consents: ConsentView[];
  earlyAccess: { status: string; joinedAt: Date; updatedAt: Date } | null;
  entitlement: UserEntitlementView;
  referral: UserReferralView;
}

/** Ayrıntı. Görüntüleme denetime yazılır (kişisel veri erişimi). */
export async function getUserDetail(
  db: Database,
  actor: AdminActor,
  publicId: string,
): Promise<UserDetail | null> {
  assertCapability(actor, "users.read");
  if (typeof publicId !== "string" || !UUID.test(publicId)) return null;

  return db.transaction(async (tx) => {
    const user = (
      await tx
        .select({
          id: appUser.id,
          publicId: appUser.publicId,
          displayName: appUser.displayName,
          avatarUrl: appUser.avatarUrl,
          email: appUser.email,
          emailVerifiedAt: appUser.emailVerifiedAt,
          referralCode: appUser.referralCode,
          role: appUser.role,
          createdAt: appUser.createdAt,
          lastSeenAt: appUser.lastSeenAt,
        })
        .from(appUser)
        .where(eq(appUser.publicId, publicId.toLowerCase()))
        .limit(1)
    )[0];
    if (!user) return null;

    const identities = await tx
      .select({
        provider: userIdentity.provider,
        providerSubject: userIdentity.providerSubject,
        emailVerified: userIdentity.emailVerified,
        createdAt: userIdentity.createdAt,
        lastSeenAt: userIdentity.lastSeenAt,
      })
      .from(userIdentity)
      .where(eq(userIdentity.userId, user.id))
      .orderBy(userIdentity.createdAt)
      .limit(10);

    // Sırayla: işlem tek bağlantı kullanır; aynı istemcide eşzamanlı sorgu
    // pg'de kullanımdan kalkıyor (pg@9'da hata).
    const sessions = await tx
      .select({ n: count() })
      .from(session)
      .where(and(eq(session.userId, user.id), gt(session.expiresAt, new Date())));
    const saved = await tx
      .select({ n: count() })
      .from(savedItem)
      .where(eq(savedItem.userId, user.id));
    const alerts = await tx
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${alert.isActive})`.mapWith(Number),
      })
      .from(alert)
      .where(eq(alert.userId, user.id));
    const creatorRows = await tx
      .select({ handle: creator.handle })
      .from(creator)
      .where(eq(creator.userId, user.id))
      .limit(1);
    const consentRows = await tx
      .selectDistinctOn([userConsent.kind], {
        kind: userConsent.kind,
        granted: userConsent.granted,
        at: userConsent.grantedAt,
      })
      .from(userConsent)
      .where(eq(userConsent.userId, user.id))
      // Güncel durum = en son satır; eşitlikte `id DESC` (0049 §6).
      .orderBy(userConsent.kind, desc(userConsent.grantedAt), desc(userConsent.id));

    const earlyAccessRows = await tx.execute(sql`
      SELECT status, created_at, updated_at FROM early_access WHERE user_id = ${user.id}
    `);
    const entitlementStatus = await getEntitlementStatus(tx, user.id);
    const ledgerTotals = await tx.execute(sql`
      SELECT reason, sum(delta)::int AS total, count(*)::int AS entries
        FROM bonus_ledger WHERE user_id = ${user.id}
       GROUP BY reason ORDER BY reason
    `);
    const chargeTotals = await tx.execute(sql`
      SELECT state, count(*)::int AS count, coalesce(sum(cost), 0)::int AS cost
        FROM ai_search_charge WHERE user_id = ${user.id}
       GROUP BY state ORDER BY state
    `);
    const recentCharges = await tx.execute(sql`
      SELECT operation, state, cost, from_daily, from_bonus, refund_reason, created_at, finalized_at
        FROM ai_search_charge WHERE user_id = ${user.id}
       ORDER BY created_at DESC LIMIT ${USER_DETAIL_HISTORY_LIMIT}
    `);
    const recentLedger = await tx.execute(sql`
      SELECT reason, delta, balance_after, created_at
        FROM bonus_ledger WHERE user_id = ${user.id}
       ORDER BY created_at DESC, id DESC LIMIT ${USER_DETAIL_HISTORY_LIMIT}
    `);
    const referralCounts = await tx.execute(sql`
      SELECT
        count(*) FILTER (WHERE status = 'pending')::int AS pending,
        count(*) FILTER (WHERE status = 'qualified')::int AS qualified,
        (SELECT coalesce(sum(delta), 0)::int FROM bonus_ledger
          WHERE user_id = ${user.id} AND reason = 'referral_inviter') AS rewards
        FROM referral WHERE inviter_user_id = ${user.id}
    `);
    const invitedByRows = await tx.execute(sql`
      SELECT status, created_at FROM referral WHERE invitee_user_id = ${user.id}
    `);

    await recordAdminEvent(tx, {
      actor,
      action: "users.view",
      targetType: "app_user",
      targetId: user.id,
    });

    const phone = identities.find((identity) => identity.provider === "phone")?.providerSubject;
    const latestConsent = new Map(consentRows.map((row) => [row.kind, row]));
    const ea = earlyAccessRows.rows[0] as
      | { status: string; created_at: string | Date; updated_at: string | Date }
      | undefined;
    const referralRow = referralCounts.rows[0] as
      | { pending: number; qualified: number; rewards: number }
      | undefined;
    const invitedBy = invitedByRows.rows[0] as
      | { status: string; created_at: string | Date }
      | undefined;
    return {
      id: user.id,
      publicId: user.publicId,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      emailMasked: maskEmail(user.email),
      emailVerified: user.emailVerifiedAt !== null,
      phoneMasked: maskPhoneForAdmin(phone ?? null),
      role: user.role,
      createdAt: user.createdAt,
      lastSeenAt: user.lastSeenAt,
      identities: identities.map(({ providerSubject: _subject, ...identity }) => identity),
      activeSessions: sessions[0]?.n ?? 0,
      savedItems: saved[0]?.n ?? 0,
      alerts: { active: alerts[0]?.active ?? 0, total: alerts[0]?.total ?? 0 },
      creatorHandle: creatorRows[0]?.handle ?? null,
      consents: CONSENT_KINDS.map((kind) => {
        const row = latestConsent.get(kind);
        return { kind, latest: row ? { granted: row.granted, at: row.at } : null };
      }),
      earlyAccess: ea
        ? {
            status: ea.status,
            joinedAt: new Date(ea.created_at),
            updatedAt: new Date(ea.updated_at),
          }
        : null,
      entitlement: {
        status: entitlementStatus,
        ledgerTotals: ledgerTotals.rows as UserEntitlementView["ledgerTotals"],
        chargeTotals: chargeTotals.rows as UserEntitlementView["chargeTotals"],
        recentCharges: (
          recentCharges.rows as {
            operation: string;
            state: string;
            cost: number;
            from_daily: number;
            from_bonus: number;
            refund_reason: string | null;
            created_at: string | Date;
            finalized_at: string | Date | null;
          }[]
        ).map((row) => ({
          operation: row.operation,
          state: row.state,
          cost: row.cost,
          fromDaily: row.from_daily,
          fromBonus: row.from_bonus,
          refundReason: row.refund_reason,
          createdAt: new Date(row.created_at),
          finalizedAt: row.finalized_at ? new Date(row.finalized_at) : null,
        })),
        recentLedger: (
          recentLedger.rows as {
            reason: string;
            delta: number;
            balance_after: number;
            created_at: string | Date;
          }[]
        ).map((row) => ({
          reason: row.reason,
          delta: row.delta,
          balanceAfter: row.balance_after,
          createdAt: new Date(row.created_at),
        })),
      },
      referral: {
        code: user.referralCode,
        invitesPending: referralRow?.pending ?? 0,
        invitesQualified: referralRow?.qualified ?? 0,
        rewardsEarned: referralRow?.rewards ?? 0,
        invitedBy: invitedBy
          ? { status: invitedBy.status, at: new Date(invitedBy.created_at) }
          : null,
      },
    };
  });
}
