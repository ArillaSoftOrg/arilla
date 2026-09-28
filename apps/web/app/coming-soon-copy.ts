/**
 * Lansman öncesi landing (karar 0043). docs/copy.md "Lansman öncesi" -
 * anahtarlar yorumda. Kurallar: ürün henüz kullanıma açık değil ima
 * edilmez; sahte ürün, fiyat, tasarruf, mağaza/kullanıcı sayısı, yorum ya da
 * tarih yok. Gelecek zaman bilerek kullanılır.
 */
import { SITE_BRAND } from "./site-config.ts";

export const COMING_SOON_COPY = {
  eyebrow: "Erken Erişim", // coming_soon.eyebrow
  status: `${SITE_BRAND} yakında.`, // coming_soon.status
  headline: "Aradığın ürünü bul. Fiyatları karşılaştır. Daha akıllı alışveriş yap.", // coming_soon.headline
  body: `${SITE_BRAND}, aradığın ürünü, alternatiflerini ve farklı mağazalardaki fiyatlarını tek yerde görmeni kolaylaştırmak için yapay zekâ destekli bir alışveriş asistanı olarak geliştiriliyor.`, // coming_soon.body
  ctaNote: "Hesabınla devam et ya da yeni hesap aç; listeye otomatik eklenirsin.", // coming_soon.cta_note
  howItWorksAnchor: "Nasıl çalışacak?", // coming_soon.how_it_works_anchor

  benefitsTitle: `${SITE_BRAND} ile neler yapabileceksin?`, // coming_soon.benefits_title
  benefits: [
    {
      id: "anlat",
      title: "Ne aradığını anlatarak bul", // coming_soon.benefit_describe_title
      body: "Ürünün adını bilmen gerekmeyecek. Aklındakini kendi cümlelerinle anlatabilecek, bir fotoğraf ya da ürün bağlantısıyla başlayabileceksin.", // coming_soon.benefit_describe_body
    },
    {
      id: "karsilastir",
      title: "Fiyatları karşılaştır", // coming_soon.benefit_compare_title
      body: "Aynı ürünün farklı mağazalardaki tekliflerini yan yana görüp karar vermeden önce seçenekleri tartabileceksin.", // coming_soon.benefit_compare_body
    },
    {
      id: "alternatif",
      title: "Alternatifleri keşfet", // coming_soon.benefit_alternatives_title
      body: "Beğendiğin ürüne benzeyen, farklı bütçelere uygun seçenekleri tek yerde inceleyebileceksin.", // coming_soon.benefit_alternatives_body
    },
  ],

  howItWorksTitle: "Nasıl çalışacak?", // coming_soon.how_it_works_title
  howItWorksBody: `${SITE_BRAND} henüz kullanıma açık değil. Açıldığında her şey üç adımda olacak.`, // coming_soon.how_it_works_body
  steps: [
    {
      id: "basla",
      title: "Ara, fotoğraf yükle veya ürün bağlantısı paylaş", // coming_soon.step_start_title
      body: "Elinde ne varsa onunla başla: kısa bir tarif, bir fotoğraf ya da beğendiğin ürünün bağlantısı.", // coming_soon.step_start_body
    },
    {
      id: "analiz",
      title: `${SITE_BRAND} seçenekleri analiz etsin`, // coming_soon.step_analyze_title
      body: "Aynı ürünü ve ona benzeyen seçenekleri farklı mağazalarda bulup senin için düzenler.", // coming_soon.step_analyze_body
    },
    {
      id: "karsilastir",
      title: "Ürünleri, alternatifleri ve fiyatları karşılaştır", // coming_soon.step_compare_title
      body: "Seçenekleri yan yana gör; sana en uygun olanı sen seç.", // coming_soon.step_compare_body
    },
  ],

  buildTitle: `${SITE_BRAND}'yi geliştiriyoruz.`, // coming_soon.build_title
  buildBody: "Ürünü adım adım inşa ediyoruz. Şu an üzerinde çalıştıklarımız:", // coming_soon.build_body
  buildStatusDone: "Tamamlandı", // coming_soon.build_status_done
  buildStatusInProgress: "Geliştiriliyor", // coming_soon.build_status_in_progress
  buildUpdated: (month: string) => `Son güncelleme: ${month}`, // coming_soon.build_updated
  followTitle: "Gelişmeleri takip et", // coming_soon.follow_title

  closingTitle: "Açıldığında ilk sen haberdar ol.", // coming_soon.closing_title
  closingBody: "Erken erişim listesine katıl; hazır olduğumuzda sana haber verelim.", // coming_soon.closing_body

  adminLogin: "Admin Girişi", // coming_soon.admin_login
  // "Admin Girişi"nden gelen giriş ekranı: nötr; hesabın rolü hakkında bir şey söylemez.
  adminLoginTitle: "Hesabınla giriş yap.", // coming_soon.admin_login_title
  footerDescription: `${SITE_BRAND} yakında: aradığın ürünü bul, alternatiflerini keşfet, fiyatları karşılaştır.`, // coming_soon.footer_description

  metaTitle: `${SITE_BRAND} – Yakında`, // coming_soon.meta_title
  metaDescription: `${SITE_BRAND} yakında: aradığın ürünü bul, alternatiflerini keşfet ve farklı mağazalardaki fiyatları karşılaştır. Erken erişim listesine katıl.`, // coming_soon.meta_description
} as const;

export type BuildStatus = "done" | "in_progress";

/**
 * "Geliştiriyoruz" bölümü - elle güncellenen, gerçek durum. Yüzde, tarih ya
 * da söz yok. Bir madde bittiğinde yalnızca `status` ve `BUILD_UPDATED`
 * değişir.
 */
export const BUILD_ITEMS: readonly { id: string; title: string; status: BuildStatus }[] = [
  { id: "erken-erisim", title: "Erken erişim sistemi", status: "done" }, // coming_soon.build_item_early_access
  { id: "arama", title: "Arama deneyimi", status: "in_progress" }, // coming_soon.build_item_search
  { id: "kesif", title: "Ürün keşfi ve karşılaştırma", status: "in_progress" }, // coming_soon.build_item_discovery
  { id: "altyapi", title: "Mağaza ve fiyat altyapısı", status: "in_progress" }, // coming_soon.build_item_data
];

/** Bölümün son elle güncellendiği ay. `null`: satır gösterilmez. */
export const BUILD_UPDATED: string | null = "Eylül 2026";
