# 0097 — AI kalite ve değerlendirme paneli

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (Faz 1A-3)
**Bağımlılık:** PR #85 (değerlendirme altyapısı), PR #87 (migration 0060 tabloları, karar 0096).

## Karar

`/yonetim/ai/kalite` eklenir (`ai.read`, yalnızca yönetici; menüde "Arama ve AI").
Yeni migration ve yeni tablo yoktur: yalnızca 0060'ın `dataset_snapshot`,
`ai_eval_run`, `ai_eval_case`, `ai_error_event` tabloları ile `api_usage`
okunur.

### Gösterilenler
Gemini niyet doğruluğu; eşleştirme precision/recall/F1 ve yanlış eşleştirme
oranı; görsel benzerlik Precision@5 / NDCG@10; arama Precision@5, NDCG@10,
sıfır sonuç ve kaçırma oranı; hata türü × sağlayıcı dağılımı; algoritma/model
sürümleri; önceki koşuya göre regresyon; değerlendirme maliyeti ve geçmişi.

### Dürüstlük kuralları
- Panel **model çağırmaz**; salt okunur işlemde yalnızca kaydı okur.
- Kayıtlı değer yoksa **"Henüz veri yok"**; sıfır uydurulmaz (gerçek 0 ölçümü ile
  yokluk ayrıdır).
- Regresyon yalnızca **aynı bileşen ve aynı veri seti içeriği** (`snapshot_id`)
  olan iki ardışık koşu arasında hesaplanır; veri seti değiştiyse "eşit koşulda
  değil" denir. Tolerans 0,5 puan.
- Metrik anahtarları `eval/metric-keys.ts` sözleşmesindedir; yazıcı ve panel aynı
  tabloyu kullanır (test bunu doğrular).
- Ham sorgu, sohbet metni, vaka anahtarı ve kullanıcı kimliği seçilmez.
- Arama kalitesi canlı trafikten değil, altın sorgu setinden ölçülür.

## Reddedilen alternatifler
- **Panelde değerlendirmeyi canlı hesaplamak:** açılışta Gemini/Jina/DB yükü ve
  kural 1 ihlali riski.
- **Mevcut `/yonetim/ai` sayfasını şişirmek:** ölçülen operasyon verisi ile
  kalite ölçümü farklı kaynaklardır; ayrı sayfa ve bağlantı.
- **Regresyonu veri seti değişse de hesaplamak:** farklı örnekler üzerindeki iki
  sayı karşılaştırılamaz; sahte regresyon/iyileşme üretirdi.

## Kapsam dışı
Üretim Gemini/Jina çağıranlarının `recordAiError`'a bağlanması ve
`purgeAiErrorEvents` cron'u (ayrı küçük PR'lar). Koşuları üreten komutun
(`--record`) veritabanına yazması da ayrı iştir; o zamana kadar panel boş durumu
gösterir.
