# 0053 — Katalog kalitesi ve eşleştirme kanıtı

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

Moderatör eşleştirme kuyruğunda yalnızca iki başlık, skor ve kısa bir
açıklama görüyordu; "bu skor ne demek, neden insan bekliyor, bu ürüne başka
kim bağlı?" sorularının cevabı yoktu. Katalogdaki veri sorunları (yinelenen
barkod, geçersiz barkod, adaysız teklif, bayat teklif) ise ancak tek tek
filtrelerle bulunabiliyordu. Yetki haritası (0039), önem modeli (0052) ve
eşleştirme eşikleri/karar mantığı (0017, 0034) değişmez.

## Karar

1. **Eşleştirme kanıtı** (`packages/core/src/admin/match-evidence.ts`, saf ve
   birim testli). Her kuyruk satırı için:
   - 0–1 skor ölçeği; insan bandı (0,63–0,84) ve otomatik kabul eşiği satırın
     kendi `explain` eşiklerinden, yoksa bugünkü varsayılanlardan (öyle
     yazılır);
   - "Neden insan bekliyor": `score.auto_eligible`'ın tersi — resolver'ın
     `review` notu (renk 0029, hacim varyantı 0033), eşik altı skor, iki
     tarafta bilinmeyen marka;
   - skor bileşenleri yalnızca kayıtlı alanlardan; görsel benzerliği
     kaydedilmediği için hibrit skorda uydurulmaz;
   - kimlik uyumu (barkod/MPN: aynı, çatışıyor, farklı, eksik). "Çatışıyor"
     yalnızca resolver'ın bugün veto edeceği durumdur (iki farklı geçerli
     barkod; ya da adayın barkod kümesi tam ve teklifinkini içermiyor, 0036);
   - adaya bağlı aktif teklifler: en fazla 8 (en düşük fiyatlı), varyant
     barkodu teklif başına en fazla 12, canlı toplam ve canlı en düşük fiyat,
     aynı mağaza uyarısı. Bütün grup için iki sorgu (N+1 yok), salt okunur,
     3 sn zaman aşımı; aşılırsa kuyruk kanıtsız açılır, karar verilebilir kalır;
   - bekleme süresi (`match_candidate.created_at`).
   A/R/S, 1–5/0/Esc kısayolları, `queue-keys.ts` kilidi ve core'daki işlem /
   çakışma koruması aynen kalır. Toplu onay yok.
2. **Adaysız teklifler.** Teklif listesine durumlar: `no_candidate` (hiç aday
   kaydı yok), `rejected_only` (bütün adayları reddedilmiş), `invalid_gtin`;
   `#<id>` ile teklif kimliği araması. Teklif başına "neden" uydurulmaz:
   `pipeline.py`'ye göre varsayılan koşu her eşleşmemiş aktif teklife ya aday
   yazar ya yeni ürün açar; adaysız teklif o koşunun henüz ulaşmadığı
   tekliftir. Yalnızca ilk görülme ve kanal girdileri (barkod/MPN, görsel
   vektörü) gösterilir.
3. **`/yonetim/katalog/kalite`** (`catalog.read`, salt okunur;
   `catalog-quality.ts`). Sekiz denetim, her biri ayrı `readOnly` işlemde
   (4 sn), en çok ikisi aynı anda, toplam 15 sn bütçe; çalışmayan denetim
   `unknown`. Bulgular `AdminFinding` + en çok 10 örnek varlık (ürün, teklif,
   mağaza yönetim sayfalarına bağlantı; tam mağaza adresi yok). Önemler:
   veri hatası (yinelenen/geçersiz/çatışan barkod, bayat teklif, kabul edilmiş
   ama bağlanmamış teklif, 48 saatten eski adaysız teklif) `warning`; beklenen
   yaşam döngüsü ya da kesin olmayan sinyal (olası çift ürün, aktif teklifsiz
   ürün, pasif teklif, kapalı mağazanın teklifi, aynı ürünü 3+ kez listeleyen
   mağaza, tekliflerinin çoğu eşleşmemiş mağaza) `info`; eksik
   marka/kategori/görsel payı %20 ve üstü `warning`, altı `info`.
4. Bulguların bağlandığı ürün filtreleri `sorun=no_active_offer|duplicate_gtin`
   üst panel sayaçlarına girmez (ürün listesi açılışına ek tarama yok). Ürün
   ayrıntısında teklif düzeyi barkod görünür. Düzenleme kontrolü yok.
5. Barkod geçerliliği SQL'de `collect/identifiers.py` `gtin_valid` ile aynı
   kural, satır başına alt sorgu olmadan (300 bin teklifte 1,4 sn → 0,25 sn).

## Gerekçe

- Moderatörün kararı, resolver'ın kararıyla aynı kanıta dayanmalı; kanıt
  resolver kodundan türetilir ki ekran ile makine çelişmesin.
- Kalite denetimleri toplu ve sınırlı: 300 bin teklif ve 60 bin üründe bütün
  rapor ~0,6 sn; yeni indeks gerekmedi.

## Reddedilen alternatifler

- **Teklif başına kesin "neden adaysız" metni:** resolver kanalların sonucunu
  (trigram eşiği, veto edilen adaylar) saklamıyor; tahmin yanlış güven verir.
- **Görsel benzerliğini hibrit skordan geri hesaplamak:** uyum bonusu ve
  kırpma yüzünden tek değere inmiyor.
- **Kalite raporunu ürün listesindeki sayaçlara eklemek:** her liste
  açılışında ek tam tarama.
- **Yeni yetenek ya da düzeltme mutasyonu:** `catalog.read` yeterli;
  birleştirme/düzeltme ayrı bir karar (`catalog.write`) ister.
