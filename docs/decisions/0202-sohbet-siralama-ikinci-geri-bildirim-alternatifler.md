# 0202 — Sohbet: gerçekten farklı sıralama sekmeleri, ayrı değerlendirme oyu, alternatifler şeridi

**Tarih:** 15 Kasım 2026 · **Durum:** kabul edildi · **Bayrak:** `CHAT_UX_V2` (varsayılan kapalı)
· **Migration:** 0116 (yalnız ek tablo)

Dupe benzeri sohbet planının Faz 4 (alternatifler, ikinci geri bildirim), Faz 5 (sekmeler) ve
Faz 6'nın kalan parçaları.

## 1. Sekmeler (Faz 5)

Sekme adları (v2): **Önerilenler / En Uygun Fiyat / En İyi Eşleşmeler**. URL değerleri aynı
(`secilen`, `firsat`, `eslesme`). v2'de her sekme tek bir SQL sıralamasıdır (tek aday havuzu, tek
`ORDER BY`); ilk 4 kart etkin sıralamanın başıdır, "sabit öne çıkan 4" yoktur (karar 0200).

| Sekme | `SortMode` | Sıralama |
|---|---|---|
| Önerilenler | `balanced` | değişmez (alaka x güven x stok x fiyat yüzdeliği, aksesuar kademesi) |
| En Uygun Fiyat | `lowest_price` (yeni) | ana ürün kademesi, stokta olanlar önce, sonra en düşük **TRY** fiyatı (yurt dışı teklif karşılaştırılamaz, sona), eşitlikte skor. **Karar 0205 bunu değiştirdi:** kartta gösterilen kurla çevrilmiş TL fiyatı |
| En İyi Eşleşmeler | `best_match` (yeni) | dengeli skorun **fiyat çarpanı olmadan** hali (alaka x güven x stok), aksesuar kademesi korunur |

- `closest_match` ÇAPA ürüne benzerliktir (metin aramasında yoktur, `UnsupportedSortForIntentError`);
  `best_match` ondan ayrı, yalnız metin aramasına özgüdür. Bu yüzden yeni ad.
- `SortMode`/`TextSort`a **ek** değerler; `balanced` ve `best_deal` davranışı, `/ara` ve
  yönetim tanısı değişmedi. Bayrak kapalıyken sohbet eski üç sekmeyle çalışır (`firsat` =
  `best_deal`, `eslesme` pasif).
- Model/varyant doğrulaması (`fallback/pipeline.ts` `verify`) sıralamayı fiyata göre bozmaz:
  model numarası içeren sorguda önce doğrulanmış kademe, kademe içinde sekmenin sırası.
- Doğrulama: `text-sorts.integration.test.ts` (stoklu ana ürünler fiyatla artan, stoksuz ucuz ürün
  sonra, aksesuar en altta, `best_match` fiyat yüzdeliğinden etkilenmez, sekmeler birbirinden
  farklı) ve gerçek Chrome e2e (karışık fiyat sırasıyla eklenen ürünlerde ilk 4 kart en ucuz 4).

**Ölçülemeyen:** ranking kalitesi (P@5, NDCG@10) bu ortamda ölçülmedi — yerelde etiketli veri ve
gerçek katalog yok; `eval:search-compare` çalıştırılmadı. `lowest_price` yalnız alaka kapısını
geçen adaylar içinde fiyata göre sıralar; kapıdan geçen ama gerçekte ilgisiz ucuz ürünler
başa çıkabilir. Bayrak açılmadan önce üretim verisiyle ölçüm gerekir.

## 2. İkinci geri bildirim: ek tablo (Faz 4)

`chat_result_feedback` değiştirilmez. Birincil anahtarı `(message_id, target)` yapmak eski
uygulamanın `ON CONFLICT (message_id)` yazımını `42P10` ile kırar (dağıtım penceresinde ve
geri dönüşte), yönetim sorgularını çift saydırır ve açıklama oylarını ürün-sonuç metriğine
karıştırır. Reddedilen: PK değişimi; `target` kolonu (PK aynı kalırsa ikinci oy sığmaz).

**Karar:** yeni ek tablo `chat_explanation_feedback` (0116): mesaj başına tek satır, neden kodları
`inaccurate | unclear | irrelevant | other` (en çok 3), yorum 1..500 karakter ve 90 gün sonra NULL.

- Eski kod + yeni şema: etkilenmez. Yeni kod + eski şema: `42P01` → oy `unavailable`, görünüm
  oysuz yüklenir, dışa aktarma ve yorum temizliği tabloyu atlar; sonuç oyu ve sohbet çalışır
  (`explanation-feedback.integration.test.ts` bu sürüm matrisini sınar).
- KVKK: sohbetle CASCADE silinir; hesap dışa aktarma (`explanationFeedback`) ve 90 günlük yorum
  temizliği yeni tabloyu kapsar. Yönetim paneli kartı **yapılmadı** (mevcut sonuç oyu metrikleri
  bozulmasın diye bilinçli; ayrı iş).
- Arayüz (v2): değerlendirme metninin altında "Bu değerlendirme yardımcı oldu mu?"
  (Beğendim / Beğenmedim + isteğe bağlı neden); ürün sonlarında "Bu ürünler ihtiyacına uygun mu?"
  (mevcut sonuç oyu, yalnız soru metni değişti). İki oy bağımsızdır.

## 3. Alternatifler şeridi

"Benzer seçenekler": ilk sonucun `similarity_edge` komşuları (`findAlternatives`), sayfadaki
ürünlerle çakışanlar çıkarılır, en çok 8; **en az 3** gerçek alternatif yoksa şerit çizilmez.
Yatay kaydırılır, kendi `Suspense`'inde (ürünleri bekletmez), hata sessizce yok. Üretimde
`similarity_edge` doluluğu ölçülmedi; boşsa şerit hiç görünmez.

## 4. Faz 6 (kalan)

- Fiyatı olmayan kartta "—" yerine "Fiyat bilgisi yok" (v2; fiyat uydurulmaz).
- Kontrol sınırları (geri bildirim düğmeleri, "Tüm N sonucu gör", "Bu aramaya dön", "Yeni yanıt") `--line`
  (1,23:1) yerine `--line-strong` (açık 3,60:1, koyu 4,37:1; WCAG 1.4.11). Metin kontrastı
  (`--ink-secondary`): açık 10,1:1, koyu 12,0:1.
- Yapılmayan: istek iptali (sunucu eylemleri iptal edilemez), boş sonuçta ek öneri çipleri
  (mevcut gevşetme notları ve niyet çipleri korundu), gerçek iOS/Android cihaz testi.
