# 0154 — Trendyol kategorilerinin AliExpress sınıflandırmasında kullanımı (dinamik motor, varsayılan kapalı)

Durum: kabul edildi (motor ve etkinleştirme mekanizması); **hiçbir kapsam etkin değildir.**

## Bağlam

Karar 0153 ile `category` ağacı 158 → 4.020 düğüme çıktı (3.862 yeni, `is_discoverable = FALSE`).
Sınıflandırıcı V5 (`services/ingest/classify`) yalnızca elle yazılmış kurallarla (`taxonomy.RULES`)
çalışır; yeni düğümleri tanımaz. 3.862 kural elle yazılamaz, bakımı da yapılamaz.
AliExpress başlıkları ve kaynak yolları İngilizce, Trendyol adları Türkçedir.

## Karar

1. **Veri güdümlü aday seçimi** (`classify/dynamic.py`): kural yazmak yerine düğüm adı, hiyerarşi,
   ürün başlığı ve kaynak yolu kullanılır.
   - Türkçe düğüm kökleri (ilk 5 katlanmış karakter) → İngilizce karşılık sözlüğü:
     `classify/data/glossary_tr_en.tsv` (gözden geçirilmiş veri; geliştirme sırasında yapay zekâ
     yardımıyla yazıldı, çalışma zamanında model çağrısı yoktur).
   - Kaynak yolu → Trendyol bölgesi köprüsü: `classify/data/source_bridge.tsv` (275 yol; 18'i bölgesiz).
   - Puan: 0,60 × IDF ağırlıklı kapsama + 0,25 baş isim (zorunlu) + 0,15 üst düğüm desteği.
     Uygulama eşiği 0,78, ikinci adayla fark ≥ 0,15, öneri eşiği 0,55.
   - Kapılar: ≥2 bağımsız başlık kanıtı (ya da ilk 8 kelimede tek birincil çeviri, derinlik ≤3);
     "for/compatible/replacement" sonrası cihaz adları reddedilir; cinsiyet çatışması reddedilir;
     kardeş belirsizliğinde ortak atasına geri çekilir (LCA); kök (derinlik<2) ve "Diğer" düğümleri seçilmez.
   - **Kaynak kategoriye aşırı güven yok:** kaynak yolu tek başına asla yaprak üretmez, yalnızca bölge
     daraltır; kanıt başlıktan gelmelidir.
   - Aynı ada sahip düğümler üst yollarıyla ayrışır; belirsizse ortak ataya çekilir.
2. **Yalnızca inceltir (`refine`)**: mevcut/elle/besleme kategorileri, V5 çatışma ve başlıkla
   doğrulanmış kararları değişmez. Kaynak-yalnız V5 kararı ancak aday kesin olarak daha derin ve
   uyumluysa inceltilir; V5 `review` ancak puan ≥0,95 ve kanıt ≥2 ile kazanca dönüşür.
3. **Etkinleştirme** (`classifier_scope`, migration 0103): boş gelir; kapsam başına `off|apply`.
   `python -m classify scope list|set <yol> <mod> --by --reason --confirm`; yalnızca Trendyol'un
   oluşturduğu düğümler; her değişiklik `job_run` (`classify_scope`) ile denetlenir.
   Motor `--dynamic` bayrağı **ve** etkin kapsam varsa çalışır; etkin kural sürümü
   `RULE_VERSION + 1` olur (ayrı kontrol noktası, V5 sonuçları ezilmez).
4. **Geri alma:** kapsamı `off` yapıp `--owned-only` ile yeniden sınıflandırmak.
5. **Karşılaştırma:** `python -m classify compare` salt okunurdur (işlem geri alınır).
6. Kullanıcıya dönük kategori menüleri değişmez (`is_discoverable` dokunulmadı).

## Ölçüm (5.000 ürün, salt okunur)

| Örnek | V5 uygulanan | Dinamik değişiklik | İnceltme | Kazanç (review→applied) |
|---|---|---|---|---|
| Katmanlı 5.000 | %70,9 | %6,1 (303) | 290 | 13 |
| İlk 5.000 (6 kaynak yolu) | %38,0 | %2,8 (142) | 103 | 39 |

Sözlük erişimi: Trendyol düğümlerinin ~%50–60'ına ulaşılabilir; köprü bölge payı %97,7.
Toplam kapsama artışı küçüktür; asıl etki kaba atamaların inceltilmesidir.

## Riskler

- Doğruluk kapsama göre değişir: giyim yüksek; oto, spor, oyuncak, hobi düşük. Ölçüm model
  yargısıyladır, **insan etiketi yoktur.**
- Sözlük kapsamadığı düğümler hiç seçilmez (güvenli yön).
- **Etkinleştirme koşulu:** kapsam başına ≥300 insan etiketi ve Wilson alt sınırı ≥0,80 (karar 0139 §7).

## Reddedilen alternatifler

- Düğüm başına Python kuralı (3.862 kural, bakımı imkânsız).
- Sınıflandırma anında LLM/embedding (değişmez kural 1; maliyet ve belirlenimsizlik).
- Otomatik etkinleştirme (doğrulanmamış doğruluk).
- V5 davranışını doğrudan değiştirmek (geri alma yolu kaybolur).

## Güncelleme (27 Ekim): AI değerlendirmesinden çıkan sıkılaştırma

400 ürünlük katmanlı örnekte (iki bağımsız AI etiketleyici + AI hakem; **insan etiketi değildir**,
Wilson kapısı karşılanmış sayılmaz) dinamik motorun inceltmeleri V5'in kaba ama doğru atamasından
daha çok yanlış çıktı (ör. büyüme lambası → "Akıllı Aydınlatma", çıkartma → "Oto Küllük"). Üç sıkılaştırma:

1. Düğüm adının **tüm** genel olmayan gövdeleri başlıkta ya da kaynak yolunda geçmeli (ata ile paylaşılan
   "akıllı" gibi gövdeler de adın parçasıdır).
2. Baş sözcüğe bitişik parça/aksesuar adı (`HEAD_MODIFIERS`: "helmet visor", "phone holder") ürünün
   asıl türüdür; parça olmayan düğüm seçilmez.
3. `kullu` gövdesi genel sayılmaz ("Küllük" ile "Kullanım" aynı gövdeye düşüyordu).

Aynı örnekte (örnek-içi; tahminlerin %50'ye yakını hakemce yanlıştı): yeni tahmin sayısı 271 → 203,
önceki yanlışların 56/124'ü elendi, doğru bulunan 12 tahmin kayboldu. Kural düzeltmesi örnekle
ayarlandığı için bu sayı doğruluk iddiası değildir; kapsam açmadan önce bağımsız insan etiketi gerekir.
