# 0098 — Değerlendirme kaydı (`--record`)

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (Faz 1A-4)
**Bağımlılık:** #85 → #87 (tablolar, karar 0096) → #88 (panel, karar 0097).

## Karar
Mevcut eval komutlarına isteğe bağlı `--record` eklenir (`eval:intent`,
`search-eval.ts`, `eval:record-matching` — Python'un `--json` çıktısını okur;
iki taraf birbirini çağırmaz). Migration ve yeni tablo yoktur.

- `--record` yoksa veritabanına hiçbir şey yazılmaz (varsayılan yerel ölçüm).
- Yalnızca yerel `DATABASE_URL` (`assertLocalRecordTarget`); uzak adreste çıkış kodu 2.
- Idempotent: aynı veri seti içeriği + bileşen + algoritma/model sürümü + metrikler
  ve vaka sonuçları ikinci kez yazılmaz (advisory kilit eşzamanlı çalıştırmayı da korur).
  Aynı metrik ama farklı vaka sonucu ayrı koşudur.
- Sürüm ilişkisi: `dataset_snapshot` (içerik SHA-256, sürüm etiketi içerikten türer)
  ve `algorithm_version` (`rules@<git>`, `search@<git>`, eşleştirmede eşikler).
- Temel çizgi: aynı snapshot'taki en son koşu. Veri seti değiştiyse temel çizgi
  ve `regressed` boş kalır (karşılaştırma yapılmaz); sonuç `baselineStatus =
  dataset_changed` ile ilk koşudan ayrılır. Tolerans panelle aynıdır (0,005).
- Payda 0 olan metrik yazılmaz (`searchStoredMetrics`); 0 uydurulmaz.
- Yerellik, ölçümden ÖNCE denetlenir (`guardRecordFlag`).
- Gizlilik: vaka anahtarı hash, ayrıntı boş; ham sorgu/metin/görsel/kullanıcı yok.
- Gerçek etiketli verisi olmayan bileşen (görsel benzerlik) için kayıt yolu
  **yoktur**; metrik uydurulmaz.

## Sınırlar
- Eşleştirmede yalnızca hatalı çiftler vaka olarak yazılır (geçenler `eval_offline`
  çıktısında yok); metrikler tüm çiftleri kapsar.
- Algoritma sürümü git kısa kimliğidir: her commit yeni "sürüm" sayılır.
- Arama koşusu yerel bootstrap katalog ister.

## Reddedilen
- Python'dan doğrudan yazmak: canonical parmak izi ve vaka anahtarı ikinci kez
  uygulanırdı. Uzak DB'ye `--force` bayrağı: istenmedi.

## Birleştirme notu

İki paralel uygulama (#90, #91) tek PR'da birleştirildi: #90'ın eşleştirme
adaptörü ve içerikten türeyen sürüm etiketleri temel alındı; #91'den vaka imzalı
idempotency, `baselineStatus`, payda koruması ve erken yerellik denetimi eklendi.
