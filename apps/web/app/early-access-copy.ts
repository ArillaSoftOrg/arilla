import { SITE_BRAND } from "./site-config.ts";

/** docs/copy.md "Erken erişim" - anahtarlar yorumda. */
export const EARLY_ACCESS_COPY = {
  cta: "Erken erişime katıl", // early_access.cta
  progressLabel: "Erken erişim listesindeki kişi", // early_access.progress_label
  progressUnit: "kişi", // early_access.progress_unit
  progressValueText: (count: string, target: string) =>
    `${target} kişilik hedefin ${count} kişisi tamamlandı`, // early_access.progress_value_text
  landingNote: `${SITE_BRAND} şu an erken erişimde. Listeye katıl, açıldığında haber verelim.`, // early_access.landing_note
  loginTitle: "Erken erişime katıl. Hesabınla devam et ya da yeni hesap aç.", // early_access.login_title
  navStatus: "Erken erişim", // early_access.nav_status
  // Listeye yeni katılan (katılımdan hemen sonra, `JUST_JOINED_WINDOW_MS`).
  joinedTitle: "Erken erişim listesine alındın.", // early_access.joined_title
  joinedBody: `${SITE_BRAND} açıldığında sana haber vereceğiz. Bu hesapla tekrar giriş yaptığında durumunu buradan görebilirsin.`, // early_access.joined_body
  // Daha önce katılmış, sonradan dönen kullanıcı.
  returningTitle: "Erken erişim listemizdesin.", // early_access.returning_title
  returningBody: `${SITE_BRAND} açıldığında sana haber vereceğiz. Bu sırada ana sayfadaki arama örneklerine göz atabilirsin.`, // early_access.returning_body
  notYetOpen: `${SITE_BRAND} henüz kullanıma açık değil. Açıldığında aynı hesapla devam edebileceksin.`, // early_access.not_yet_open
  joinedOn: (date: string) => `Katılım tarihi: ${date}`, // early_access.joined_on
  inList: "Erken erişim listesindesin.", // early_access.in_list
  viewStatus: "Durumunu gör", // early_access.view_status
  joinTitle: "Erken erişim listesine katıl", // early_access.join_title
  joinBody: `Listeye katıl, ${SITE_BRAND} açıldığında haber verelim.`, // early_access.join_body
  joinSubmit: "Listeye katıl", // early_access.join_submit
  backHome: "Ana sayfaya dön", // early_access.back_home
  logout: "Çıkış yap", // action.logout
} as const;
