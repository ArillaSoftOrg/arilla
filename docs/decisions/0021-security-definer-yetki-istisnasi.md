# 0021 — `SECURITY DEFINER` trigger'ları, yetki modelinde duran bir istisnadır

**Tarih:** 2026-09 · **Durum:** kabul edildi · **İlgili:** [`0020`](0020-polimorfik-butunluk.md), `0010_append_only_grants.sql`

Kısa kayıt. `0020`'nin kararını tekrar etmez; **yetki modeline** ne yaptığını
yazar, çünkü orası `0020`'yi okumayan birinin çalışacağı yer.

## Neden `DEFINER` gerekliydi

`0014`'ün trigger fonksiyonları polimorfik `target_id` bütünlüğünü sağlar.
Trigger fonksiyonu varsayılan olarak **çağıran** rolün yetkisiyle koşar; bu
ölçüldü:

| | Sonuç |
| --- | --- |
| `SECURITY INVOKER`, çağıranın hedef tabloda DELETE'i yok | `ERROR: permission denied` |
| `SECURITY DEFINER`, aynı roller | temizlik yapıldı |

Yani bütünlük garantisinin `arilla_app`'in GRANT'lerine bağlı olmaması için
`DEFINER` gerekliydi. Karşılığı: `arilla_app`'e tek bir yetki eklemeden
bütünlük sağlanıyor (`has_function_privilege(..., 'EXECUTE')` bugün `false`).

## Bedeli — sessiz kalması

`DEFINER`'ın bütün amacı çağıranın yetkisini **atlamak**. Bunun kaçınılmaz
sonucu: `arilla_app`'in yetkileri daraltıldığında bu trigger'lar **sesini
çıkarmaz**. Çalışmaya devam ederler.

İki ayrı sorun doğurur:

1. **Sinyal kaybı.** Yetki modelini daralttığınızda bu kod yolunun etkilenip
   etkilenmediğini gösteren hiçbir hata almazsınız.
2. **Asıl risk — istemeden delinen kural.** `embedding` ya da
   `generated_content` bir gün `price_point` gibi **append-only** yapılırsa
   (`REVOKE DELETE`), `0014`'ün trigger'ları o kuralı deler: satırları
   silmeye devam ederler ve bunu ilan etmezler. Bu, `CLAUDE.md` 4. kuralın
   bu iki tabloya genişletilmesi gibi görünen bir değişikliğin **sessizce
   yarım kalması** demektir.

Kural: `DEFINER` bir kolaylık değil, yetki modelinde **duran bir
istisnadır**. Yazılı olmayan istisna, istisna değil hatadır.

## `arilla_app`'in yetkileri değiştirilirse ne kontrol edilir

Bu listeye `0010`'u değiştiren her migration'da bakılır.

1. **Niyet sorusu — önce bu.** Yeni GRANT/REVOKE `embedding` ya da
   `generated_content` üzerinde silmeyi engellemeyi mi amaçlıyor? Amaçlıyorsa
   `0014` trigger'ları o kuralın **bilinçli istisnasıdır**; bu dosyaya
   yazılır. Amaçlamıyorsa devam.
2. `pnpm db:verify` — `0020`'nin dört iddiası hâlâ geçiyor mu (trigger'lar
   var ve etkin, DELETE ve TRUNCATE yolları temizliyor, yetim sayısı sıfır).
   Bu iddialar mutasyonla doğrulandı; geçmeleri anlamlıdır.
3. Fonksiyonlar hâlâ `DEFINER` ve sahibi hâlâ `arilla` mı:
   ```sql
   SELECT proname, prosecdef, proowner::regrole, proconfig
     FROM pg_proc WHERE proname LIKE 'enforce_polymorphic%';
   ```
   `prosecdef` **`t`**, `proconfig` içinde `search_path=...` olmalı.
4. `EXECUTE` hâlâ kimseye açılmamış mı:
   ```sql
   SELECT has_function_privilege('arilla_app', 'enforce_polymorphic_delete()', 'EXECUTE');
   ```
   **`false`** beklenir. `true` dönerse biri `PUBLIC`'e ya da role yetki
   vermiş demektir; `DEFINER` fonksiyonu doğrudan çağrılabilir hale gelmiştir.
5. Fonksiyonların **sahibi değişirse**, yeni sahibin `embedding` ve
   `generated_content` üzerinde DELETE'i olduğu doğrulanır — yoksa trigger
   çalışma anında patlar.

## Reddedilen alternatif

- **`INVOKER`'a dönüp `arilla_app`'e açıkça DELETE vermek.** Sinyali geri
  getirirdi (yetki alınınca trigger gürültüyle düşerdi) ama bütünlüğü
  uygulama rolünün GRANT'lerine bağlardı ve `embedding`'i append-only yapmayı
  imkânsız kılardı. İstisnayı yazmak, istisnayı uygulama rolüne dağıtmaktan
  ucuz.
