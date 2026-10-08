# 0083 — Yönetim Faz B: arayüz temeli, gezinme ve genel bakış

**Tarih:** 8 Ekim 2026
**Durum:** Kabul edildi

0039 (tek kabuk, yetki haritası), 0055 (gezinme) ve 0082 (kapsam kaydı)
üzerine. Adresler, yetenekler, server action'lar, denetim kaydı ve iş
mantığı **değişmez**. Migration yok.

## Karar

1. **Tek tasarım sistemi.** `apps/web/app/yonetim/admin.module.css` yalnızca
   `packages/ui/src/tokens.css` belirteçlerini kullanır; yeni UI çatısı ya da
   ikinci bir belirteç kümesi yok (0039 reddi geçerli). Görsel dil design.md
   0026'nın yönetime uyarlanmasıdır: kanvas `--surface`, paneller
   `--surface-raised` + 1px `--line`, kartlarda gölge yok; renk yalnızca anlam
   (`--alert` kritik, `--warning` uyarı, `--save` başarı); rakamlar tabular;
   büyük harf yok. Yoğunluk: masaüstünde 36px kontrol/32px menü satırı, kaba
   işaretçide (`pointer: coarse`) 44px. Kırılımlar yalnızca 640/1024/1440.
   Mevcut sınıf adları korunur; sayfalar dokunulmadan yeni görünümü alır.
2. **Ortak bileşenler** (`admin-ui.tsx`, sunucu): `PageHeader` (açıklama,
   eylemler), `Section`, `Panel`, `KpiCard`/`KpiGroup` (+ `Tile` geriye
   uyum), `DataBasis` (tam sayım / tahmini / rızalı örneklem / ölçülmüyor /
   dış kaynak — 0082 kapsam sınıfları ekranda), `DataTable` (640px altında
   etiketli kart satırları), `FilterBar`/`FilterField` (GET, değerler adres
   satırında), `Pager`, `Tabs` (adres tabanlı), `StatusBadge`, tonlu `Notice`
   (hata `role=alert`, başarı `role=status`), `EmptyPanel`, `Skeleton`.
   İstemci: `AdminDialog` (yerel modal `<dialog>`; `ConfirmButton` onun
   üzerinde). Yeni modüller (AI, analitik, katalog, trend, affiliate) düzeni
   bunlarla kurar.
3. **Gezinme.** Gruplar alana göre: Genel bakış · Katalog · Arama ve AI ·
   Kullanıcılar ve iletişim · İçerik · İşletim · Güvenlik (trendler → İçerik,
   affiliate → yeni "Gelir"). Gruplar yerel `<details>` ile katlanır; etkin
   sayfanın grubu açılır; katlama durumu saklanmaz (tarayıcı deposu yok).
   1024px altında aynı menü üst çubuktaki "Menü" düğmesiyle modal `<dialog>`
   çekmecede açılır (odak tuzağı/Esc/odak dönüşü tarayıcıdan; gezinme kapatır;
   örtüye tıklama kapatmaz; açıkken kaydırma kilitli). "İçeriğe geç"
   bağlantısı eklendi; konum yolu üst çubukta.
4. **Rota düzeyi `loading.tsx` YOK.** Yükleniyor sınırı akışı başlatır; sonra
   sayfadaki `notFound()` 200 + `noindex`'e, `redirect()` istemci
   yönlendirmesine döner (Next 16 "The HTTP contract"). Bu, moderatörün
   yönetici sayfasına isteğinin 404 durumunu (0039 m.4) bozardı. Geri
   bildirim bunun yerine tıklanan menü bağlantısında `useLinkStatus` ile sabit
   boyutlu nokta; yavaş bölümler gerekirse yetki denetiminden SONRA sayfa
   içinde `<Suspense>` + `Skeleton` ile sarılır.
5. **Genel bakış** yalnızca gerçek veri: dikkat listesinden türetilen önem
   özeti, alana göre gruplanmış kartlar (her biri veri temeli rozetiyle),
   boru hattı ve dikkat gerektiren mağazalar panelleri. Yeni tek veri: son 7
   gün metin araması, sonuçsuz oranı ve yedek listeye düşen
   (`search_query_day`, kimliksiz; tek sınırlı sorgu). "Arama günlüğü
   tutulmuyor" notu 0052'den beri yanlıştı, kaldırıldı. Menünün kopyası olan
   "Araçlar" listesi kaldırıldı.

## Sınırlar

- Yeni bileşenler bu fazda yalnızca genel bakışta kullanıldı; diğer sayfalar
  ortak sınıflar üzerinden yeni görünümü aldı ama `DataTable`/`FilterBar`'a
  sayfa sayfa taşınmadı (Faz C ile birlikte).
- Menü açıklamaları hâlâ yalnızca `title`'da (dokunmatikte görünmez); sayfa
  açıklaması üst çubukta konum yolunun altında yazar.
- Tarayıcıda yalnızca masaüstü (1440px, koyu tema) doğrulandı; dar ekran
  çekmecesi ve açık tema gözle doğrulanmadı (pencere küçültülemedi, iframe
  `frame-ancestors` ile doğru biçimde engellendi).

## Reddedilen alternatifler

- **Hazır bileşen kütüphanesi / ikinci tasarım sistemi:** 0039; belirteçler
  yeterli, üçüncü taraf CDN yasağı.
- **Rota düzeyi `loading.tsx`:** yukarıda m.4.
- **Menü durumunu `localStorage`'da tutmak:** depo olmadan çalışmayan akış
  kurulmaz (CLAUDE.md); oturum içi durum layout'ta zaten korunur.
- **Katlanabilir ikon-yalnız yan menü:** ikon seti yok, metin etiketleri
  Türkçe uzun; yoğunluk kazancı erişilebilirlik maliyetine değmez.
