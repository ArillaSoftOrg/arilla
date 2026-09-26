# 0040 — Reddedilen eşleşme yeniden önerilmez

**Tarih:** 26 Eylül 2026
**Durum:** Kabul edildi

## Karar

1. `services/ingest/resolve/pipeline.py` `best_match`, bir offer için insanın
   `rejected` işaretlediği ürünleri **her katmanda** eler: varyant barkodu,
   kesin kimlik (GTIN/MPN), metin ve görsel aday havuzu. İnsan kararı
   eşleştirme kanıtından üstündür.
2. Reddedilen ürün elendikten sonra akış olağan şekilde devam eder: bir
   sonraki aday eşiği geçerse kuyruğa ya da otomatik kabule gider, geçmezse
   offer için yeni ürün açılır.
3. İkinci savunma: `resolve_offers` offer'ı yalnızca `UPSERT_CANDIDATE`'in
   **saklanan** durumu `auto_accepted` ise bağlar. Satırda insan kararı
   (`accepted`/`rejected`) duruyorsa makine bağlamaz.

## Gerekçe

Bulunan arıza (regresyon testi: `services/ingest/tests/test_resolve_rejected_pair.py`):
reddedilen çift bir sonraki koşuda yine en iyi aday çıkıyordu. Upsert insan
kararını ezmediği için satır `rejected` kalıyordu, ama skor otomatik kabul
kademesindeyse `LINK_OFFER` yine çalışıyor ve offer **reddedilen ürüne
bağlanıyordu**. Kademe altındaysa offer hiç eşleşmeden kalıyor, her koşuda
yeniden skorlanıyordu. İki durumda da `/yonetim/eslestirme`'deki red etkisizdi.

## Reddedilen alternatifler

- **Reddedilen offer'ı kalıcı olarak eşleştirme dışı bırakmak.** Offer
  katalogdan düşerdi; doğru cevap çoğu zaman başka bir ürün ya da yeni ürün.
- **Red nedeni kodu (`review_reason`) beklemek.** Ayrı bir iş; bu düzeltme
  ona bağlı değil.
