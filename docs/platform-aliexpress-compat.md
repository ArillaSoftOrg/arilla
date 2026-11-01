# AliExpress sistemiyle uyumluluk değerlendirmesi

Karar: `docs/decisions/0163`. Değerlendirme kod okuma + testlerle yapıldı; AliExpress'e karşı üretimde
hiçbir şey çalıştırılmadı.

## Davranış değişikliği

- `catalog_build/policy.py`: `POLICIES` ve `SOURCE_LISTING_MERCHANTS` artık `platforms.registry` kaydından türetilir.
  AliExpress ve Hepsiburada için kimlik kalıpları, `discovery_source` ve `url_kind` birebir taşındı.
  `test_catalog_build_policy.py` ve `test_hb_catalog_policy.py` değişmeden geçti.
- `HEPSIBURADA_URL` ve `hepsiburada_code_kind` aynı adlarla `policy.py`dan dışa verilmeye devam eder
  (`feeds/intake.py` kullanıyor).
- Şema, migration, `feeds/*`, `gate.py`, `publish.py`, `resolve/*` değişmedi. Üretim davranışı aynı olmalı.

## Çakışma

- Dokunduğum mevcut dosya yalnızca `catalog_build/policy.py`. `git merge-tree` ile açık AliExpress dalları
  (`aliexpress-daily-price-sync`, `catalog-publish-stale-guard`, `feed-drop-explicit-approval`,
  `feeds-retry-truncated`, `aliexpress-source-catalog`) denendi: çakışan dosyalar `feeds/*`, `docs/ops.md`,
  `apps/web/*`; `policy.py` ve `platforms/*` yok. Ancak bu dallardan biri `policy.py`/`profiles.py`
  değiştirirse (özellikle yeni kaynak kuralı eklerse) kuralı `registry.py`ye eklemek gerekir.
- Karar numarası 0163 (0162 main'de #245 tarafından alındı); migration kullanılmadı.

## Registry'deki AliExpress değerleri (yorum gerektiren)

`constraints` değerleri mevcut koddan/kararlardan alındı ama bazıları KOD tarafından henüz OKUNMUYOR:
yenileme aralığı (11 sa), `max_price_age` (2 gün; gate/publish kendi sabitini kullanır), dakika sınırı.
Yani registry bugün bilgilendirici; `feeds/daily.py`, `gate.py` bu değerlere bağlanana dek iki kaynak var.
`foreign_currency_display=True` mevcut yurt dışı fiyat gösterimini yansıtır; ürün kararı değişirse buradan değişir.

## Birleştirme öncesi sorular

1. `feeds/daily.py` ve `gate.py`/`publish.py` sabitlerini registry'ye bağlayalım mı (AliExpress dalları bitince)?
2. `price_point` yazım politikası tek tipe indirilsin mi (`feeds/sync.py` değişimde, `collect/writer.py` her gözlemde)?
3. Kısıtlar DB'ye (ayrı migration) taşınsın mı, yoksa kodda mı kalsın?
4. Kimlik vermeyen AliExpress ilanları için `matching.py` yalnızca `singleton` üretir; bu beklenen davranış.
