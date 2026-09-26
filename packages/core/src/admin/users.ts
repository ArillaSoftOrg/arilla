/**
 * `/yonetim/kullanicilar` (Faz 6): SALT OKUNUR kullanıcı bulma. Yalnızca
 * yönetici (`users.read`).
 *
 * - Liste/gezinme YOK: yalnızca tam eşleşme (e-posta, E.164 telefon, public id).
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

export interface UserDetail {
  id: number;
  publicId: string;
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
  /** Her rıza türünün en son durumu. */
  consents: { kind: string; granted: boolean; at: Date }[];
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
          email: appUser.email,
          emailVerifiedAt: appUser.emailVerifiedAt,
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

    const [sessions, saved, alerts, creatorRows, consentRows] = await Promise.all([
      tx
        .select({ n: count() })
        .from(session)
        .where(and(eq(session.userId, user.id), gt(session.expiresAt, new Date()))),
      tx.select({ n: count() }).from(savedItem).where(eq(savedItem.userId, user.id)),
      tx
        .select({
          total: count(),
          active: sql<number>`count(*) filter (where ${alert.isActive})`.mapWith(Number),
        })
        .from(alert)
        .where(eq(alert.userId, user.id)),
      tx
        .select({ handle: creator.handle })
        .from(creator)
        .where(eq(creator.userId, user.id))
        .limit(1),
      tx
        .selectDistinctOn([userConsent.kind], {
          kind: userConsent.kind,
          granted: userConsent.granted,
          at: userConsent.grantedAt,
        })
        .from(userConsent)
        .where(eq(userConsent.userId, user.id))
        .orderBy(userConsent.kind, desc(userConsent.grantedAt)),
    ]);

    await recordAdminEvent(tx, {
      actor,
      action: "users.view",
      targetType: "app_user",
      targetId: user.id,
    });

    const phone = identities.find((identity) => identity.provider === "phone")?.providerSubject;
    return {
      id: user.id,
      publicId: user.publicId,
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
      consents: consentRows,
    };
  });
}
