# 0054 — Arama kalitesi ölçümü ve arama tanısı

**Tarih:** 3 Ekim 2026
**Durum:** Kabul edildi

0052 `search_query_day` tablosunu açtı ama yazan ve okuyan yoktu; yönetim
arama tanısı tek skor ve ham JSON gösteriyordu, sözlük sayfasındaki "kademe 3"
listesi (model kademesi yok) hep boştu.

## Karar

1. **Ölçüm** (`packages/core/src/search/quality.ts`): `/ara` metin aramasının
   yeni bir aramanın varsayılan sekmedeki ilk sayfası `recordTextSearchQuality`
   ile sayılır (sayfa/sekme gezinmesi aynı aramayı ikinci kez saymaz).
   `after()` ile yanıttan sonra çalışır; hata aramayı bozmaz, yalnızca hata
   sınıfı loglanır, sorgu metni loglanmaz. Görsel ve link araması, konuşma
   adımları ve yönetim tanısı yazmaz.
   - Gün sınırı **Europe/Istanbul**: ekran Türkiye takvimiyle okunur.
   - Sayaçlar: arama, sonuçsuz (toplam 0), yedek (sonuçsuzken boş olmayan
     filtresiz liste gösterildi), netleştirme (soru soruldu). Son sonuç
     sayısı, kademe ve tanınmayan kelimeler son aramanınkidir.
   - **Kişisel veri süzgeci** sözlük okunmadan önce çalışır: `@`, URL/alan
     adı, 7+ haneli rakam dizisi, telefon kalıbı (3/4+3+2+2 hane), açık adres
     işareti (mahalle, sokak, cadde, "no: 5" ...) içeren ya da 200 karakteri
     aşan sorgu hiç yazılmaz. Yanlış pozitif (bir sorgunun sayılmaması)
     kabul; yanlış negatif değil.
   - **Tanınmayan kelime**: ayrıştırıcının tüketmediği ve hiçbir sözlük
     yüzeyine denk gelmeyen kelimeler; bağlaç ve rakam atılır; en fazla 8,
     her biri ≤ 40 karakter.
   - Analitik olayı **değildir** (docs/events.md): kimlik yok, rızaya bağlı
     değil, kişiyle ilişkilendirilemez. 90 gün saklanır:
     `purgeSearchQueryDays` (cron bağlantısı ayrı iş).
2. **Arama tanısı** (`/yonetim/arama/tani`): boru hattı adım adım (sorgu →
   ayrıştırıcı → sözlük → anlaşılanlar → aday kapıları → sıralama →
   netleştirme → sonuç); ham JSON ikincil. Aday CTE'si, filtre, metin kapısı,
   skor ve görsel tekilleştirme `search-sql.ts`'e taşındı; `/ara` ve tanı
   aynı yapı taşlarını kullanır. Skor çarpanları (`balancedScoreFactors`)
   skorun kendisini üreten ifadelerdir, ayrı kolon olarak okunur; "En iyi
   fırsatlar"da skor tek çarpandır ve öyle gösterilir.
3. **"Bu ürün neden burada değil?"**: kimlik ya da slug ile tek ürün için
   her kapı aynı SQL ifadeleriyle ayrı ölçülür (teklif/mağaza durumu,
   ön filtre, metin kapısı, her filtre, fiyat istatistiği, görsel
   tekilleştirme, sıra). Ölçülmeyen neden yazılmaz; hiçbiri tutmazsa
   "kanıtlanabilir neden yok" denir. Salt okunur, zaman aşımlı, tanı kotasından düşer.
4. **Sorunlu sorgular** (`/yonetim/sozluk`): son 7/30 günün sonuçsuz, yedek,
   tanınmayan kelimeli ve sık sorguları; sık tanınmayan kelimeler. Okuma
   yeteneği `diagnostics.read` (arama gözlemi; sözlük yazma yetkisi
   kullanıcı sorgularını okuma yetkisi vermez). Akış: İncele (tanı) →
   Sözlüğe ekle (form ön dolu; kaydetmeden yazılmaz, mevcut denetimli
   mutasyon) → tanıda doğrula. Otomatik yazma ve model önerisi yok.

## Reddedilen alternatifler

- **Tanıda ayrı bir sıralama kopyası:** gerçeği değil kopyayı açıklar;
  zamanla ayrışır.
- **Kelime çıkarımını ayrıştırılmış önbellekten yapmak (sözlük okumadan):**
  eş anlamlı ve "tarzı" ile atlanan markayı tanınmayan sayardı; sözlük okuması
  `after()` içinde, istek yolunu yavaşlatmaz.
- **Tanının da sayaca yazması:** ölçümü personel denemeleriyle kirletir.
