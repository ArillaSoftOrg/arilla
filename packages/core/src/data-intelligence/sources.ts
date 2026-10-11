/**
 * Veri kaynağı ve hukuki dayanak kaydı (Faz 1/4). Burası "ne toplanıyor" sorusunun
 * kod karşılığıdır; `getCollectionAudit` bunu canlı sayımla birleştirir.
 * Toplanmayan bir olay burada `not_collected` olarak durur — toplanıyormuş gibi
 * gösterilmez (docs/events.md ile birebir).
 */

export type CollectionStatus = "collected" | "partial" | "not_collected";
/** Ticari lisans amacı için hukuki durum. Hiçbiri bugün "cleared" değil. */
export type LicensingStatus = "unverified" | "barred" | "not_applicable";

export interface CollectionAuditSpec {
  key: string;
  label: string;
  /** İstenen olay adı → gerçek olay/tablo karşılığı. */
  events: string;
  status: CollectionStatus;
  sources: readonly string[];
  /** Neden toplanıyor (hizmet amacı ve hukuki dayanağı). */
  collectionBasis: string;
  licensingStatus: LicensingStatus;
  licensingNote: string;
  recordPoint: string;
  missingFields: readonly string[];
  duplicateRisk: string;
  /** Veri setlerinde kullanılıyor mu. */
  datasetUse: "used" | "not_used";
  datasetNote: string;
}

export const COLLECTION_AUDIT: readonly CollectionAuditSpec[] = [
  {
    key: "product_search",
    label: "Ürün araması",
    events: "search_submitted (user_activity_event) + search_query_day",
    status: "partial",
    sources: ["user_activity_event", "search_query_day"],
    collectionBasis:
      "Rızalı olay: yalnızca girişli + analitik rızalı kullanıcı, yalnızca metin araması. search_query_day: kimliksiz günlük sayaç (meşru menfaat, hizmet kalitesi).",
    licensingStatus: "unverified",
    licensingNote:
      "Analitik rızası hizmet analitiği içindir; üçüncü tarafa lisanslama amacı rıza metninde yok. search_query_day anonim olduğu garanti edilmeyen veridir (kvkk.md).",
    recordPoint:
      "packages/core/src/activity/record.ts#recordActivity; search/quality.ts (search_query_day)",
    missingFields: [
      "kategori/marka/fiyat alanı yok (yalnızca query_norm)",
      "fotoğraf ve link araması bu olayı üretmez",
      "özel nitelikli/kimlik benzeri sorguda query_norm NULL",
    ],
    duplicateRisk:
      "Düşük: 10 dk aynı sorgu bastırılır, (user_id, event_id) tekil. Eski (sürüm 1) satırlarda event_id yok.",
    datasetUse: "not_used",
    datasetNote:
      "Serbest metin sorgu ticari veri setine girmez (ayırt edici, kişisel olabilir); kişi sayısı olmayan search_query_day için k-eşiği ölçülemez.",
  },
  {
    key: "product_category",
    label: "Ürün kategorisi",
    events: "ayrı olay yok; product.category_id üzerinden türetilir",
    status: "partial",
    sources: ["user_activity_event", "product", "category"],
    collectionBasis: "Kategori ürünün kataloğundaki atamasıdır; olay anında saklanmaz.",
    licensingStatus: "unverified",
    licensingNote: "Türetim, rızalı product_viewed/merchant_exit olaylarına dayanır.",
    recordPoint: "türetilir: user_activity_event × product × category (build zamanında)",
    missingFields: [
      "olay anındaki kategori saklanmaz; katalog yeniden sınıflanırsa geçmiş dönem kayar",
      "kategorisiz ürün (category_id NULL) sınıflanamaz",
    ],
    duplicateRisk:
      "Yok (türetim). Kategori ataması hatalı olabilir: doğruluk örneklemesiyle ölçülür.",
    datasetUse: "used",
    datasetNote: "category_trends; is_discoverable=false (hassas) kategoriler elenir.",
  },
  {
    key: "brand_price",
    label: "Marka ve fiyat aralığı",
    events: "ayrı olay yok; product.brand_id ve click.price_at_click üzerinden türetilir",
    status: "partial",
    sources: ["user_activity_event", "product", "brand", "click"],
    collectionBasis:
      "Marka katalogdan. Fiyat yalnızca mağaza çıkışında (click.price_at_click) olay anındaki değerdir.",
    licensingStatus: "unverified",
    licensingNote:
      "click satırları kaynak değildir (events.md); yalnızca rızalı merchant_exit olayının click_id'si ile fiyat özniteliği okunur.",
    recordPoint: "türetilir; fiyat: attribution/record-click.ts (price_at_click)",
    missingFields: [
      "ürün görüntülemede olay anı fiyatı yok (yalnızca güncel min_price) → görüntüleme fiyat bandına girmez",
      "arama sorgusunda fiyat aralığı alanı yok",
    ],
    duplicateRisk: "Yok (türetim). Marka adı beslemeden gelir; slug biçimi doğrulanır.",
    datasetUse: "used",
    datasetNote: "brand_interest_trends; price_range_trends yalnızca merchant_exit için.",
  },
  {
    key: "product_view",
    label: "Ürün görüntüleme",
    events: "product_viewed (user_activity_event)",
    status: "collected",
    sources: ["user_activity_event"],
    collectionBasis: "Rızalı (girişli + analitik rızası). Kaynak sayfa (`source`) yazılmaz.",
    licensingStatus: "unverified",
    licensingNote:
      "Ayrı bir `product_view` tablosu da vardır: kullanıcının KENDİ gezinme geçmişidir (browsing_history rızası, son 50) — analitiğe kaynak olmaz.",
    recordPoint: "packages/core/src/activity/record.ts#recordActivity",
    missingFields: ["source (kaynak yüzey) yazılmaz", "anonim ziyaretçi için kayıt yok"],
    duplicateRisk: "Düşük: aynı ürün 30 dk bastırılır; event_id ile tekil (sürüm 2).",
    datasetUse: "used",
    datasetNote: "category_trends ve brand_interest_trends (event_type=product_view).",
  },
  {
    key: "product_card_click",
    label: "Ürün kartına tıklama",
    events: "discovery_item_clicked (tanımlı)",
    status: "not_collected",
    sources: [],
    collectionBasis:
      "Yazan kod yok (events.md: arama/creator/keşfet olayları bugün hiçbir yere yazılmaz).",
    licensingStatus: "not_applicable",
    licensingNote:
      "Toplanmayan veri için hukuki değerlendirme gerekmez; yazılmadan önce sınıfı eklenmeli.",
    recordPoint: "—",
    missingFields: ["olay hiç yazılmıyor"],
    duplicateRisk: "—",
    datasetUse: "not_used",
    datasetNote: "Ürün sayfası görüntüleme kart tıklaması değildir; karıştırılmaz.",
  },
  {
    key: "merchant_click",
    label: "Satıcı bağlantısına tıklama",
    events: "click (attribution, tüm ziyaretçiler) + merchant_exit (rızalı analitik kopya)",
    status: "collected",
    sources: ["click", "user_activity_event"],
    collectionBasis:
      "click: mali mevzuat ve sözleşme (kural 8), her çıkışta. merchant_exit: yalnızca analitik rızasıyla.",
    licensingStatus: "barred",
    licensingNote:
      "click davranışsal analitiğe/ticari veri setine kaynak OLMAZ (events.md, 0049 §5). Yalnızca rızalı merchant_exit kullanılabilir ve o da hukuki dayanak bekler.",
    recordPoint:
      "packages/core/src/attribution/record-click.ts (click); activity/record.ts (merchant_exit)",
    missingFields: [
      "source_similarity_kind: hiçbir yüzey yazmıyor (hep NULL)",
      "result_position yalnızca liste yüzeylerinde",
      "dönüşüm/gelir: conversion'a yazan entegrasyon yok",
    ],
    duplicateRisk:
      "Düşük: 5 sn aynı oturum+teklif tekrar satır üretmez; bot/prefetch /git'te elenir (1B-1); merchant_exit kimliği click_id'den türer.",
    datasetUse: "used",
    datasetNote:
      "price_range_trends ve category/brand (event_type=merchant_exit); click tablosu kaynak değil.",
  },
  {
    key: "image_search",
    label: "Görsel arama",
    events: "ai_search_charge (hizmet kaydı); analitik olayı yok",
    status: "partial",
    sources: ["ai_search_charge"],
    collectionBasis:
      "Sözleşmenin ifası: arama hakkı hesabı. Ham görsel 30 gün içinde silinir (kural 10).",
    licensingStatus: "barred",
    licensingNote:
      "Hak defteri hizmet kaydıdır; görsel ve görsel özellikleri ticari çıktıya girmez.",
    recordPoint: "packages/core/src/entitlement/ (ai_search_charge)",
    missingFields: ["analitik olay yazılmıyor", "sonuç/kategori bilgisi yok"],
    duplicateRisk: "İdempotent hak kaydı; analitik sayım için kullanılmaz.",
    datasetUse: "not_used",
    datasetNote: "Yalnızca sayaç olarak admin paneline yansır; veri setine girmez.",
  },
  {
    key: "similar_product_search",
    label: "Benzer ürün arama",
    events: "analitik olayı yok (sohbet link araması: sohbet tabloları)",
    status: "not_collected",
    sources: [],
    collectionBasis: "Sohbet ve link araması içeriği ham mesajdır; analitik olarak ayrıştırılmaz.",
    licensingStatus: "barred",
    licensingNote: "Ham sohbet mesajı ve ürün linki ticari çıktıya girmez (Faz 4).",
    recordPoint: "—",
    missingFields: ["benzer ürün arama olayı yazılmıyor"],
    duplicateRisk: "—",
    datasetUse: "not_used",
    datasetNote: "Üretilemez.",
  },
  {
    key: "alternative_preference",
    label: "Alternatif ürün tercihi",
    events: "alternatives_shown / alternative_clicked (tanımlı, yazılmıyor)",
    status: "not_collected",
    sources: [],
    collectionBasis:
      "events.md: alternative_clicked tanımlı ama yazılmaz; click.source_similarity_kind'i yazan yüzey yok.",
    licensingStatus: "not_applicable",
    licensingNote: "Yazılmayan veri için değerlendirme gerekmez.",
    recordPoint: "—",
    missingFields: ["gösterim", "tıklama", "list_position", "matched_kind"],
    duplicateRisk: "—",
    datasetUse: "not_used",
    datasetNote: "alternative_search_trends üretilemez; boş/uydurma kayıt oluşturulmaz.",
  },
];

/** Politika `clearedSources` ile eşleşen kaynak kimliklerinin hukuki notu. */
export const LICENSING_SOURCE_NOTE: Readonly<Record<string, string>> = {
  user_activity_event:
    "Analitik rızası (0049) hizmet analitiği içindir; üçüncü tarafa lisanslama için ayrı hukuki dayanak/rıza metni onaylanmadı.",
};
