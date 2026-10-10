/**
 * Yönetim kapsam kaydı (docs/decisions/0082). "Platformda olan her anlamlı
 * şey yönetimde görünür mü?" sorusunun tek, test edilen cevabı.
 *
 * Bu dosya ekran DEĞİLDİR ve hiçbir veri okumaz: alt sistemlerin, tabloların,
 * model işlemlerinin, cron uçlarının, yeteneklerin ve denetim hedeflerinin
 * yönetimdeki durumunu sınıflandırır. Testler (`coverage.test.ts`, web
 * tarafında `coverage-pages.test.ts`) depodaki gerçek listelerle karşılaştırır:
 * yeni bir tablo, model işlemi, cron ucu ya da iş adı burada sınıflandırılmadan
 * eklenirse test kırılır.
 *
 * Durumlar:
 * - `visible`        Yönetimde görünür (en az bir sayfada).
 * - `data_no_ui`     Veri var, yönetim ekranı yok.
 * - `unmeasured`     Veri yok; ölçüm (kod/şema) gerekir.
 * - `external`       Veri platform dışında; dış entegrasyon gerekir.
 * - `not_applicable` Bu üründe yok (gerekçe zorunlu).
 *
 * Gizlilik sınırları (0049, 0074, 0079) burada da geçerlidir: "data_no_ui"
 * bir ekranın kişi bazında açılacağı anlamına gelmez; `privacy` notu sınırı
 * yazar.
 */
import type { AdminTargetType } from "./audit.ts";
import type { Capability } from "./capabilities.ts";

export type CoverageStatus =
  | "visible"
  | "data_no_ui"
  | "unmeasured"
  | "external"
  | "not_applicable";

export interface CoverageGap {
  /** Eksik sinyal; operatörün sorusu biçiminde. */
  signal: string;
  status: Exclude<CoverageStatus, "visible">;
}

export interface SubsystemCoverage {
  id: string;
  label: string;
  /** Bu alt sistemin sahip olduğu tablolar (`docs/schema.sql`). */
  tables: readonly string[];
  /** Ana durum: alt sistemin temel sinyali bugün nerede. */
  status: CoverageStatus;
  /** Görünür olduğu yönetim sayfaları (`/yonetim/...`); `visible` ise en az bir tane. */
  adminPaths: readonly string[];
  /** Bilinen eksikler (Faz B+ iş listesi). */
  gaps: readonly CoverageGap[];
  /** Gizlilik ya da kapsam sınırı; boş olabilir. */
  privacy?: string;
  /** `not_applicable` ve `external` için gerekçe. */
  note?: string;
}

export const ADMIN_SUBSYSTEMS: readonly SubsystemCoverage[] = [
  {
    id: "merchants_ingest",
    label: "Mağazalar ve veri toplama",
    tables: ["merchant", "ingest_run"],
    status: "visible",
    adminPaths: ["/yonetim/magazalar", "/yonetim/ingest"],
    gaps: [],
  },
  {
    id: "catalog",
    label: "Katalog: ürün, teklif, varyant, fiyat",
    tables: [
      "product",
      "product_slug_history",
      "brand",
      "category",
      "offer",
      "offer_variant",
      "variant_price_event",
      "variant_stock_event",
      "price_point",
      "price_point_2026_09",
      "price_point_2026_10",
      "price_point_default",
      "product_price_stats",
    ],
    status: "visible",
    adminPaths: [
      "/yonetim/katalog/urunler",
      "/yonetim/katalog/teklifler",
      "/yonetim/katalog/kalite",
    ],
    // Karar 0085: tazelik, stok ve liste fiyatı şişirme sayısı kalite sayfasında.
    gaps: [
      {
        signal: "Liste fiyatı şişirilen ürünlerin listesi (bugün yalnızca sayı)",
        status: "data_no_ui",
      },
    ],
  },
  {
    id: "catalog_images",
    label: "Ürün görselleri",
    tables: ["offer_image"],
    status: "visible",
    adminPaths: ["/yonetim/katalog/kalite"],
    gaps: [
      { signal: "Görsel boyutu ve kopya (perceptual_hash) dağılımı", status: "data_no_ui" },
      { signal: "Kırık görsel (status='broken' hiç yazılmıyor)", status: "unmeasured" },
    ],
  },
  {
    id: "matching",
    label: "Eşleştirme",
    tables: ["match_candidate"],
    status: "visible",
    adminPaths: ["/yonetim/eslestirme", "/yonetim/eslestirme/gecmis"],
    gaps: [],
  },
  {
    id: "similarity_enrichment",
    label: "Vektör, benzerlik ve AI içerik",
    tables: ["embedding", "similarity_edge", "generated_content"],
    status: "visible",
    adminPaths: ["/yonetim/islemler"],
    gaps: [{ signal: "AI özet (generated_content) kapsamı", status: "data_no_ui" }],
  },
  {
    id: "search_text",
    label: "Metin araması ve sözlük",
    tables: ["search_query_day", "query_resolution", "lexicon"],
    status: "visible",
    // Karar 0083: 7 günlük arama ve sonuçsuz oranı genel bakışta.
    adminPaths: ["/yonetim", "/yonetim/sozluk", "/yonetim/arama/tani", "/yonetim/yolculuk"],
    gaps: [{ signal: "query_resolution önbellek isabeti", status: "data_no_ui" }],
    privacy: "search_query_day kimliksizdir; kişisel veri içeren sorgu hiç yazılmaz (0052).",
  },
  {
    id: "search_interpretation",
    label: "Gemini sorgu yorumu (toplu + anlık)",
    tables: ["query_interpretation"],
    status: "visible",
    adminPaths: ["/yonetim/ai", "/yonetim/arama/tani"],
    gaps: [],
  },
  {
    id: "search_visual",
    label: "Fotoğrafla arama",
    tables: ["image_upload"],
    status: "visible",
    adminPaths: ["/yonetim/arama/gorsel"],
    gaps: [{ signal: "Sonuç sayısı", status: "unmeasured" }],
    privacy: "Görsel, nesne anahtarı ve yükleyen gösterilmez (0041).",
  },
  {
    id: "search_link",
    label: "Link araması",
    tables: ["link_resolution_request"],
    status: "visible",
    adminPaths: ["/yonetim/arama/link"],
    gaps: [],
    privacy: "Adres sorgu dizisi olmadan gösterilir (redact.ts).",
  },
  {
    id: "search_rights",
    label: "Arama hakkı ve bonus",
    tables: ["ai_quota_day", "ai_search_charge", "bonus_account", "bonus_ledger"],
    status: "visible",
    adminPaths: ["/yonetim/kullanicilar", "/yonetim/ai", "/yonetim/yolculuk"],
    gaps: [],
  },
  {
    id: "referral",
    label: "Davet",
    tables: ["referral"],
    status: "visible",
    adminPaths: ["/yonetim/yolculuk"],
    gaps: [],
  },
  {
    id: "chat",
    label: "Konuşmalı keşif (sohbet)",
    tables: ["conversation", "chat_message", "chat_attachment"],
    status: "visible",
    adminPaths: ["/yonetim/ai"],
    gaps: [
      { signal: "Tur sonucu (yanıt, netleştirme, sağlayıcı hatası)", status: "unmeasured" },
      { signal: "Sohbet ve anlık yorum kota reddi (Redis, kalıcı değil)", status: "unmeasured" },
    ],
    privacy: "Sohbet metni ve ekleri yalnızca sahibine görünür (0074, 0078, 0079 m.10).",
  },
  {
    id: "chat_feedback",
    label: "Sohbet yanıt oyu, neden ve yorum",
    tables: ["chat_result_feedback"],
    status: "visible",
    adminPaths: ["/yonetim/ai-geri-bildirim"],
    gaps: [],
    privacy:
      "Sohbet metni gösterilmez; her liste/ayrıntı görüntülemesi denetime yazılır, yorum 90 gün (0079).",
  },
  {
    id: "ai_usage",
    label: "Model kullanımı ve maliyet",
    tables: ["api_usage"],
    status: "visible",
    adminPaths: ["/yonetim/islemler", "/yonetim/ai"],
    gaps: [
      { signal: "Çağrı sonucu (başarılı/hata) ve gecikme", status: "unmeasured" },
      { signal: "Girdi/çıktı token ayrımı (yalnızca toplam saklanıyor)", status: "unmeasured" },
      { signal: "Gerçek faturalanan tutar", status: "external" },
    ],
    privacy: "Sohbet satırlarında user_id var: kullanıcı başına AI maliyeti gösterilmez.",
  },
  {
    id: "accounts",
    label: "Hesaplar, kimlikler, oturumlar",
    tables: [
      "app_user",
      "user_identity",
      "session",
      "auth_token",
      "phone_login_code",
      "user_size_profile",
    ],
    status: "visible",
    adminPaths: ["/yonetim/kullanicilar", "/yonetim/yolculuk"],
    gaps: [{ signal: "Başarısız giriş denemesi", status: "unmeasured" }],
    privacy: "İletişim bilgisi maskeli; tam gösterim taze giriş + denetim (0049).",
  },
  {
    id: "auth_events",
    label: "Giriş olayları",
    tables: ["auth_event"],
    status: "visible",
    adminPaths: ["/yonetim/kullanicilar", "/yonetim/yolculuk"],
    gaps: [
      {
        signal: "Cihaz sınıfı ve ülke dağılımı (toplu; sağlayıcı yolculukta)",
        status: "data_no_ui",
      },
    ],
  },
  {
    id: "consent",
    label: "Rıza kayıtları",
    tables: ["user_consent"],
    status: "visible",
    adminPaths: ["/yonetim/kullanicilar", "/yonetim/yolculuk"],
    gaps: [],
  },
  {
    id: "user_activity",
    label: "Kullanıcı aktivitesi ve gezinme",
    tables: ["user_activity_event", "user_activity_summary", "product_view"],
    status: "visible",
    adminPaths: ["/yonetim/kullanicilar", "/yonetim/yolculuk"],
    gaps: [{ signal: "Anonim ziyaret ve kimliksiz huni", status: "unmeasured" }],
    privacy:
      "Yalnızca girişli + analitik rızalı kullanıcılar (0049): toplamlar 'rızalı örneklem' diye etiketlenir.",
  },
  {
    id: "early_access",
    label: "Erken erişim",
    tables: ["early_access", "early_access_counter"],
    status: "visible",
    adminPaths: ["/yonetim/erken-erisim"],
    gaps: [],
    note: "Başvuru durumu yalnızca 'pending' (CHECK); erişim verme akışı yok (karar 0086).",
  },
  {
    id: "inbox",
    label: "İletişim ve geri bildirim gelen kutusu",
    tables: ["feedback"],
    status: "visible",
    adminPaths: ["/yonetim/mesajlar"],
    // Karar 0086: durum/öncelik triyajı var; sorumlu kişi kolonu yok (migration).
    gaps: [{ signal: "Sorumlu kişi ve ilgilenme zamanı", status: "unmeasured" }],
  },
  {
    id: "forms",
    label: "Formlar ve anketler",
    tables: [
      "form",
      "form_question",
      "form_question_option",
      "form_response",
      "form_answer",
      "form_skip",
    ],
    status: "visible",
    adminPaths: ["/yonetim/formlar"],
    gaps: [],
  },
  {
    id: "marketing",
    label: "Pazarlama e-postası",
    tables: ["marketing_campaign", "marketing_campaign_delivery"],
    status: "visible",
    adminPaths: ["/yonetim/kampanyalar"],
    gaps: [],
  },
  {
    id: "price_alerts",
    label: "Fiyat alarmları",
    tables: ["alert"],
    status: "visible",
    adminPaths: ["/yonetim/yolculuk"],
    gaps: [{ signal: "İşlemsel e-posta teslimi", status: "unmeasured" }],
  },
  {
    id: "affiliate_clicks",
    label: "Mağaza çıkışı (attribution)",
    tables: ["click", "creator_affiliate_account"],
    status: "visible",
    adminPaths: ["/yonetim/affiliate"],
    gaps: [{ signal: "Bot/şüpheli tıklama", status: "unmeasured" }],
    privacy:
      "click davranış analitiğine, kullanıcı sayacına ya da segmente kaynak olmaz (events.md, 0049 §5).",
  },
  {
    id: "affiliate_conversions",
    label: "Dönüşüm ve gelir",
    tables: ["conversion"],
    status: "external",
    adminPaths: ["/yonetim/affiliate"],
    gaps: [],
    note: "Tabloya yazan kod yok; affiliate ağı raporu/postback entegrasyonu gerekir.",
  },
  {
    id: "creator_content",
    label: "Creator, koleksiyon, takip, kaydetme",
    tables: ["creator", "collection", "collection_item", "follow", "saved_item"],
    status: "data_no_ui",
    adminPaths: [],
    gaps: [{ signal: "Creator/koleksiyon moderasyonu", status: "data_no_ui" }],
  },
  {
    id: "discovery",
    label: "Keşfet, kullanıcı keşfi, sponsorlu trend",
    tables: ["discovery_slot", "public_find", "trend_snapshot"],
    status: "data_no_ui",
    adminPaths: [],
    gaps: [{ signal: "Slot içeriği, public_find kaynağı, sponsor rozeti", status: "data_no_ui" }],
  },
  {
    id: "trends",
    label: "Trend koleksiyonları",
    tables: ["trend", "trend_product"],
    status: "visible",
    adminPaths: ["/yonetim/trendler"],
    // Karar 0086: durum, öne çıkarma, sıra yönetimde; ürün bağları curate işinde kalır.
    gaps: [{ signal: "Yayın penceresi ve kapak görseli düzenleme", status: "data_no_ui" }],
  },
  {
    id: "jobs",
    label: "İş koşuları",
    tables: ["job_run"],
    status: "visible",
    adminPaths: ["/yonetim/islemler", "/yonetim/islemler/isler"],
    gaps: [{ signal: "Uyarı geçmişi ve bildirim", status: "unmeasured" }],
  },
  {
    id: "ai_eval",
    label: "AI değerlendirme ve model hata veri seti",
    tables: ["dataset_snapshot", "ai_eval_run", "ai_eval_case", "ai_error_event"],
    status: "data_no_ui",
    adminPaths: [],
    // Karar 0096: şema ve yazıcı var; yönetim ekranı ve üretim çağıranlarına bağlama yok.
    gaps: [{ signal: "Koşu karşılaştırması ve hata dağılımı ekranı", status: "data_no_ui" }],
  },
  {
    id: "audit",
    label: "Denetim kaydı",
    tables: ["admin_audit_event"],
    status: "visible",
    adminPaths: ["/yonetim/denetim"],
    gaps: [{ signal: "KVKK dışa aktarım talebi kaydı", status: "unmeasured" }],
  },
  {
    id: "app_errors",
    label: "Uygulama hataları (5xx, istisna)",
    tables: [],
    status: "external",
    adminPaths: [],
    gaps: [],
    note: "Hata izleme yok; log akışı gerekir, kişisel veri taşımamalı.",
  },
  {
    id: "infrastructure",
    label: "Veritabanı, depolama, Search Console",
    tables: [],
    status: "external",
    adminPaths: [],
    gaps: [],
    note: "Supabase/R2 panoları ve Search Console API'si; panelde yalnızca kendi SEO tanımız var.",
  },
  {
    id: "web_traffic",
    label: "Site trafiği (GA4, rızalı)",
    // Veri GA4'te; veritabanında tablo yok (karar 0087).
    tables: [],
    status: "visible",
    adminPaths: ["/yonetim/trafik"],
    gaps: [
      {
        signal: "Analitik rızası vermeyen ziyaretçi (bilerek ölçülmez)",
        status: "unmeasured",
      },
    ],
    privacy:
      "Yalnızca rızalı ve arındırılmış page_view; 5 kullanıcı altı coğrafya/kaynak satırı birleştirilir.",
  },
  {
    id: "configuration",
    label: "Özellik bayrakları ve tavanlar",
    tables: [],
    status: "visible",
    adminPaths: ["/yonetim/ayarlar"],
    gaps: [],
    privacy:
      "Sırlar yalnızca tanımlı/tanımsız/geçersiz olarak; değer asla gösterilmez (karar 0086).",
  },
  {
    id: "mcp",
    label: "MCP / B2B / uzantı kanalı",
    tables: [],
    status: "not_applicable",
    adminPaths: [],
    gaps: [],
    note: "apps/mcp depoda yok; api_usage.b2b_client_id hiç yazılmıyor.",
  },
];

/** `api_usage.operation` değerleri; yeni değer sınıflandırılmadan yazılamaz (test). */
export type AiPricing =
  /** `llm/pricing.ts` sürümlü kuralları + kur (karar 0082). */
  | "llm_rule"
  /** `EMBEDDING_COST_MICROS_PER_1K_TOKENS` (TS ve Python aynı kural). */
  | "embedding_env";

export interface AiOperationCoverage {
  label: string;
  writer: "core" | "python";
  pricing: AiPricing;
}

export const AI_OPERATIONS: Readonly<Record<string, AiOperationCoverage>> = {
  visual_search: { label: "Görsel arama embedding", writer: "core", pricing: "embedding_env" },
  image_embedding: {
    label: "Katalog görsel embedding",
    writer: "python",
    pricing: "embedding_env",
  },
  text_embedding: { label: "Katalog metin embedding", writer: "python", pricing: "embedding_env" },
  chat_turn: { label: "Sohbet turu (Gemini)", writer: "core", pricing: "llm_rule" },
  query_interpretation: {
    label: "Sorgu yorumu, toplu (Gemini)",
    writer: "core",
    pricing: "llm_rule",
  },
  query_interpretation_realtime: {
    label: "Sorgu yorumu, anlık (Gemini)",
    writer: "core",
    pricing: "llm_rule",
  },
};

/** `apps/web/app/api/cron/<ad>` → yazdığı `job_run.job` (KNOWN_JOBS'ta olmalı). */
export const CRON_ROUTES: Readonly<Record<string, { job: string }>> = {
  "cleanup-auth": { job: "cleanup_auth" },
  "generate-discovery-slots": { job: "discovery_slots" },
  "interpret-queries": { job: "query_interpretation" },
  "marketing-campaigns": { job: "marketing_campaigns" },
  "refresh-product-aggregates": { job: "product_aggregates" },
  "trigger-alerts": { job: "trigger_alerts" },
};

export type CapabilityClass = "monitor" | "analyze" | "manage" | "audit" | "platform";

export interface CapabilityCoverage {
  class: CapabilityClass;
  /** Kişisel veri açar; her görüntüleme denetime yazılmalı. */
  sensitive: boolean;
  /** Tanımlı ama henüz kullanılmayan (gerekçeli); test kullanılmamasına izin verir. */
  reserved?: string;
}

/** Her yetenek sınıflandırılır; `Record<Capability, …>` eksik yeteneği derlemede yakalar. */
export const CAPABILITY_COVERAGE: Readonly<Record<Capability, CapabilityCoverage>> = {
  "admin.access": { class: "monitor", sensitive: false },
  "merchant.read": { class: "monitor", sensitive: false },
  "ingest.read": { class: "monitor", sensitive: false },
  "operations.read": { class: "monitor", sensitive: false },
  "catalog.read": { class: "analyze", sensitive: false },
  "diagnostics.read": { class: "analyze", sensitive: false },
  "users.read": { class: "analyze", sensitive: true },
  "users.activity.read": { class: "analyze", sensitive: true },
  "users.contact.reveal": { class: "analyze", sensitive: true },
  "messages.read": { class: "analyze", sensitive: true },
  "feedback.chat.read": { class: "analyze", sensitive: true },
  "matching.review": { class: "manage", sensitive: false },
  "dictionary.write": { class: "manage", sensitive: false },
  "merchant.manage": { class: "manage", sensitive: false },
  "catalog.write": {
    class: "manage",
    sensitive: false,
    reserved: "Katalog düzenleme ayrı karar ister (0039, catalog.ts).",
  },
  "users.sessions.revoke": { class: "manage", sensitive: false },
  "early_access.manage": { class: "manage", sensitive: false },
  "forms.manage": { class: "manage", sensitive: true },
  "marketing.manage": { class: "manage", sensitive: false },
  "audit.read": { class: "audit", sensitive: true },
  "product.preview": { class: "platform", sensitive: false },
  // Karar 0085: yalnızca toplamlar; kişi bazında görünüm yok.
  "ai.read": { class: "monitor", sensitive: false },
  "analytics.read": { class: "analyze", sensitive: false },
  "affiliate.read": { class: "analyze", sensitive: false },
  // Karar 0086: yönetim (gerekçe + taze giriş + denetim) ve salt okunur yapılandırma.
  "trends.manage": { class: "manage", sensitive: false },
  "messages.triage": { class: "manage", sensitive: true },
  "config.read": { class: "monitor", sensitive: false },
  // Karar 0087: GA4 toplamları; kişi düzeyi yok.
  "traffic.read": { class: "analyze", sensitive: false },
};

/** Her denetim hedefi bir alt sisteme bağlıdır (`Record` eksik hedefi derlemede yakalar). */
export const AUDIT_TARGET_SUBSYSTEM: Readonly<Record<AdminTargetType, string>> = {
  match_candidate: "matching",
  lexicon: "search_text",
  merchant: "merchants_ingest",
  app_user: "accounts",
  marketing_campaign: "marketing",
  form: "forms",
  feedback: "inbox",
  chat_feedback: "chat_feedback",
  trend: "trends",
  early_access_counter: "early_access",
  capability: "audit",
};

/** Kayıtta geçen bütün tablolar (test: `docs/schema.sql` ile birebir). */
export function coveredTables(): string[] {
  return ADMIN_SUBSYSTEMS.flatMap((s) => s.tables);
}
