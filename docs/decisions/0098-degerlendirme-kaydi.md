# 0098 — Değerlendirme komutları sonucu isteğe bağlı kaydeder

**Tarih:** 10 Ekim 2026 · **Durum:** kabul edildi (Faz 1A-4)

## Karar

1. `eval:intent` ve `eval:search` komutlarına `--record` eklenir. Verilmezse
   veritabanına yazılmaz.
2. Yalnızca yerel `DATABASE_URL`; uzak adres reddedilir, otomatik uzak kayıt yok.
3. Yazım `packages/core/src/eval/record.ts` (`recordEvalResult`) üzerinden, 0060
   tablolarına; migration yok. Ham sorgu/metin yazılmaz (`case_key` hash).
4. Idempotency: aynı snapshot + bileşen + algoritma sürümü + metrikler + vaka
   sonuçları → yeni satır yok, var olan kimlik. Eşzamanlı çağrılar
   `pg_advisory_xact_lock` ile sıralanır.
5. Karşılaştırma yalnızca aynı snapshot (aynı içerik parmak izi) için; içerik
   değiştiyse regresyon hesaplanmaz.
6. Etiketli veri yoksa/payda 0 ise metrik yazılmaz; eşleştirme ve görsel
   bileşenleri bu işte kaydedilmez.

## Gerekçe

Panel (0097) için gerçek kayıt gerekir; ama sessiz yazım, uzak DB'ye sızma ve
farklı veri setleri arasında sahte "regresyon" güvenilirliği bozar.

## Reddedilen

- **Varsayılan kayıt:** yerel ölçümün veritabanı gerektirmesi ve yan etki.
- **Koşu düzeyinde tekil kısıt (migration):** uygulama düzeyi kilit yeterli.
- **Veri seti değişince eski koşuyla karşılaştırma:** farklı örnekler üzerinde
  anlamsız fark.
