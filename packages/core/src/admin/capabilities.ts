/**
 * `/yonetim` yetki haritası (docs/decisions/0039). Rol sistemi değişmez:
 * `app_user.role` tek kaynaktır, burada yalnızca rolden yeteneğe sabit bir
 * eşleme vardır. Tablo yok, arayüzden rol atama yok — rol yükseltme hâlâ
 * yalnızca elle SQL ile yapılır.
 *
 * İki savunma hattı:
 * 1. `apps/web/app/lib/dal.ts` `requireCapability` — her sayfa ve server action.
 * 2. Buradaki `assertCapability` — her core mutasyonu kendi içinde tekrar
 *    denetler. Yarın `apps/api` ya da `apps/mcp` aynı fonksiyonu çağırırsa
 *    web katmanındaki kontrolü atlayamaz.
 */
import type { UserRole } from "../auth/types.ts";

export type Capability =
  | "admin.access"
  | "matching.review"
  | "dictionary.write"
  | "catalog.read"
  | "diagnostics.read"
  | "merchant.read"
  | "ingest.read"
  | "merchant.manage"
  | "catalog.write"
  | "audit.read"
  | "users.read"
  /** `/yonetim/islemler`: partition, yetim, maliyet, KVKK temizlik durumu. */
  | "operations.read";

/** Mutasyonu yapan kişi. Rol, istek anında veritabanından okunmuş olmalıdır. */
export interface AdminActor {
  userId: number;
  role: UserRole;
}

const MODERATOR_CAPABILITIES: readonly Capability[] = [
  "admin.access",
  "matching.review",
  "dictionary.write",
  "catalog.read",
  "diagnostics.read",
  "merchant.read",
  "ingest.read",
];

const ADMIN_CAPABILITIES: readonly Capability[] = [
  ...MODERATOR_CAPABILITIES,
  "merchant.manage",
  "catalog.write",
  "audit.read",
  "users.read",
  "operations.read",
];

const ROLE_CAPABILITIES: Readonly<Record<UserRole, ReadonlySet<Capability>>> = {
  user: new Set(),
  creator: new Set(),
  moderator: new Set(MODERATOR_CAPABILITIES),
  admin: new Set(ADMIN_CAPABILITIES),
};

/** Bilinmeyen rol (ör. ileride eklenen ama buraya işlenmeyen) hiçbir yetki almaz. */
export function hasCapability(role: UserRole, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role]?.has(capability) ?? false;
}

export class AdminForbiddenError extends Error {
  readonly capability: Capability;

  constructor(capability: Capability) {
    super(`yetki yok: ${capability}`);
    this.name = "AdminForbiddenError";
    this.capability = capability;
  }
}

export function assertCapability(actor: AdminActor, capability: Capability): void {
  if (!hasCapability(actor.role, capability)) {
    throw new AdminForbiddenError(capability);
  }
}
