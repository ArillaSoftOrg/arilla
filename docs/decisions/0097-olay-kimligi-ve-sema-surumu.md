# 0097 — Davranışsal olaylarda `event_id` ve `schema_version`

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (Faz 1B-2)

## Karar

1. `user_activity_event`e iki kolon eklenir (migration 0061):
   - `event_id UUID` (nullable). `(user_id, event_id)` tekildir.
   - `schema_version SMALLINT NOT NULL DEFAULT 1`. **1** = eski biçim, `event_id`
     yok. **2** = `event_id` zorunlu (CHECK). Yeni yazıcı yalnızca 2 yazar.
2. Tekrar yazım `INSERT … ON CONFLICT (user_id, event_id) DO NOTHING` ile
   tekilleşir; çakışmada `recordActivity` `"duplicate"` döner ve sayaç artmaz.
   UPDATE yetkisi açılmaz.
3. `event_id` çağıranın verdiği UUID ya da üretilen rastgele UUID'dir.
   `merchant_exit` için tıklamadan türetilir (`merchantExitEventId`): aynı
   `click_id` ikinci kez yazılamaz.
4. Mevcut kapılar aynen geçerlidir: giriş, analitik rızası, hesap tarafı ret
   kontrolü, pencere tekrar bastırması. `event_id` hiçbirini atlatmaz; rıza
   yoksa veritabanına gidilmeden `"no_consent"` döner.

## Gerekçe

Yeniden deneme ve çift istek tek olay üretmeli; olay biçimi değişecekse eski
satırlar ayırt edilebilmeli. Rastgele/türetilmiş UUID kişisel veri değildir; yeni
izleme ya da profilleme eklenmez.

## Reddedilen

- **Tüm satırlara geriye dönük `event_id` (backfill + NOT NULL):** büyük tabloda
  yeniden yazım ve kilit; eski satırlara uydurma kimlik. Sürüm 1 = kimliksiz.
- **Küresel tekil `event_id`:** başka kullanıcının kimliğiyle çakışma/yoklama
  olurdu; kapsam kullanıcıdır.
- **İstemciden gelen `schema_version`:** sürümü yalnızca sunucu yazar.
