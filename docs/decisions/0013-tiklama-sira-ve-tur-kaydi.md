# 0013 — Tıklama sırası ve eşleşen benzerlik türü `click` tablosunda kalıcı tutulur

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

`click` tablosuna iki nullable kolon eklenir (`0011_click_result_position.sql`):

1. **`source_similarity_kind`** — tıklanan alternatifi üreten
   `similarity_edge.kind` değeri. `similarity_edge.kind` CHECK listesiyle
   birebir aynı: `same`, `visual`, `semantic`, `substitute`.
2. **`result_position`** — tıklanan alternatifin listede gösterildiği sıra
   (`SMALLINT`).

Aynı bilgi `docs/events.md`'deki `alternative_clicked` olayına da eklenir
(`list_position`, `matched_kind`). Analitik olayı davranışı ölçer, `click`
tablosu kalıcı attribution kaydıdır — ikisi arasındaki ayrım
`docs/events.md`'nin `merchant_exit` için zaten kurduğu ilkeyle aynıdır:
"attribution kaynağı her zaman veritabanıdır."

## Gerekçe

**Neden veritabanında, yalnızca analitik olayında değil.** `click`,
`conversion` ile join edilebilen tek kayıttır. Hangi sıradaki ve hangi
benzerlik türündeki alternatifin gerçek dönüşüme (ve dolayısıyla komisyona)
dönüştüğünü ölçmek bu join'i gerektirir. Yalnızca analitik akışında tutulan
bir alan gelir raporlamasına giremez — analitik olayları `session_id`
üzerinden `api_usage` ile birleşir (`docs/events.md`, "api_usage ile
ilişki"), `conversion` ile değil.

**Neden nullable, NOT NULL değil.** Geçmiş `click` satırlarının bu bilgisi
yok; NOT NULL geçmiş veriyi geçersiz kılardı ya da sahte bir varsayılan
gerektirirdi. Doğrudan bağlantı yapıştırma gibi benzerlik listesinden
gelmeyen tıklamalar da vardır. `packages/db/migrations/README.md`'nin "önce
kolon eklenir" kuralıyla ve `CLAUDE.md` 14. kuralla uyumlu, saf ek
(additive) migration.

**Neden `similarity_edge.kind` CHECK'i birebir kopyalanıyor.** Ayrı bir
foreign key yerine aynı CHECK listesinin kopyalanması tercih edildi: `click`,
belirli bir `similarity_edge` satırına değil, o satırın **türüne** referans
verir; `similarity_edge`'in birincil anahtarı zaten üçlü
(`product_a, product_b, kind`) olduğundan buraya tekil bir FK vermek
anlamsız olurdu. Bedeli bilinçli kabul edildi: `similarity_edge.kind`'a
üçüncü bir tür eklenirse iki CHECK de güncellenmeli.

**İsimlendirme notu (kasıtlı sapma).** `docs/events.md`'deki olay alanı
`list_position`, buradaki SQL kolonu `result_position` olarak adlandırıldı —
aynı bilgi iki farklı isimle iki farklı yüzeyde durur. Şemadaki mevcut
`position` kolonları (`collection.position`, `collection_item.position`,
`discovery_slot.position`) önek almadan kullanılırken, bu görevde açıkça
istenen `result_position` adı o kalıba **uydurulmadı**; iki isimlendirme
kararı ayrı bağlamlarda (JSON olay alanı vs. SQL kolonu) ayrı ayrı verildi
ve öyle bırakıldı.

## Reddedilen alternatifler

- **Yalnızca analitik olayında tutmak (`docs/events.md`, kalıcı olmayan
  akış).** `conversion` ile join edilemediği için gelir/komisyon
  raporlamasına giremez; hangi sıralamanın/türün gerçek satışa dönüştüğünü
  ölçmek imkansızlaşırdı.
- **`click` yerine ayrı bir `click_context` tablosu.** Bire-bir ilişki için
  ayrı tablo gereksiz join maliyeti ekler; iki nullable kolon aynı bilgiyi
  taşır.
- **`source_similarity_kind` için foreign key.** `similarity_edge`'in
  bileşik anahtarı türü değil belirli bir kenarı adresler; burada gereken
  tür bilgisidir, kenar kimliği değil.

## Sonucu

- `packages/db/migrations/0011_click_result_position.sql` — `click`
  tablosuna iki nullable kolon ekler.
- `docs/schema.sql` — `click` tanımı güncellenir.
- `packages/db/migrations/README.md` — "Sıra" tablosuna yeni satır.
- `docs/events.md` — `alternative_clicked` satırı ve yeni "Türetilmiş niyet
  sinyalleri" bölümü.
