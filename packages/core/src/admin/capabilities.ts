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
  | "operations.read"
  /**
   * Lansman öncesi kapalı ürünü görme (`PRODUCT_ACCESS` kapalıyken).
   * YALNIZCA yönetici (karar 0043): moderatör yönetim konsolunu kullanır
   * ama public ürün kilidini aşamaz.
   */
  | "product.preview"
  /**
   * `/yonetim/kampanyalar`: pazarlama e-postası taslağı, test gönderimi,
   * gerçek gönderim (taze giriş ile, karar 0044) ve iptal. Yalnızca yönetici
   * (karar 0048).
   */
  | "marketing.manage"
  /**
   * `/yonetim/formlar`: form / anket olusturma, yayinlama, kapatma ve
   * sonuclari gorme (karar 0058). Yanitlar hesaba bagli olabilir; yalnizca
   * yonetici.
   */
  | "forms.manage"
  /**
   * `/yonetim/mesajlar`: iletişim formu ve geri bildirim gelen kutusu (karar
   * 0061). Ad, e-posta ve serbest metin içerir; yalnızca yönetici. Her liste
   * görüntülemesi `messages.list_view` olarak denetime yazılır.
   */
  | "messages.read"
  /**
   * Kullanıcı ayrıntısının hassas sekmeleri: Aktivite, Oturumlar, Aramalar,
   * Affiliate (karar 0049 §3). Yalnızca yönetici; her görüntüleme
   * `users.view_tab` olarak denetime yazılır.
   */
  | "users.activity.read"
  /**
   * Tam e-posta/telefonu tek hesap için gösterme (karar 0049 §2). Yalnızca
   * yönetici ve taze giriş ister (`requireFreshCapability`); her gösterim
   * `users.reveal_contact` olarak yazılır, değerin kendisi yazılmaz.
   */
  | "users.contact.reveal"
  /**
   * Bir hesabın bütün oturumlarını kapatma (ele geçirilmiş hesap şüphesi).
   * Yalnızca yönetici, taze giriş ile (karar 0050).
   */
  | "users.sessions.revoke";

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
  // Karar 0043: lansman öncesi önizleme yalnızca yöneticinin.
  "product.preview",
  // Karar 0048: kullanıcılara toplu e-posta yalnızca yöneticiden.
  "marketing.manage",
  // Karar 0058: form / anket merkezi yalnizca yoneticinin.
  "forms.manage",
  // Karar 0061: iletisim/geri bildirim gelen kutusu kisisel veri icerir.
  "messages.read",
  // Karar 0049: kullanıcı aktivitesi ve tam iletişim bilgisi yalnızca yöneticinin.
  "users.activity.read",
  "users.contact.reveal",
  // Karar 0050: oturum kapatma yalnızca yöneticiden.
  "users.sessions.revoke",
];

const ROLE_CAPABILITIES: Readonly<Record<UserRole, ReadonlySet<Capability>>> = {
  user: new Set(),
  creator: new Set(),
  moderator: new Set(MODERATOR_CAPABILITIES),
  admin: new Set(ADMIN_CAPABILITIES),
};

const NO_CAPABILITIES: ReadonlySet<Capability> = new Set();

/**
 * Rolün yetenekleri (salt okunur kopya). Arayüzde bağlantı gösterim koşulu
 * içindir (`FindingList`); yetki kararı her zaman `hasCapability`/
 * `assertCapability` ile sunucuda verilir.
 */
export function capabilitiesFor(role: UserRole): ReadonlySet<Capability> {
  return new Set(ROLE_CAPABILITIES[role] ?? NO_CAPABILITIES);
}

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
