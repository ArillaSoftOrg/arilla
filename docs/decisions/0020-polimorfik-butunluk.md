# 0020 — Polimorfik `target_id` bütünlüğü

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Bağlam — B3'te bulunan arıza

`embedding` ve `generated_content` tablolarında `target_id` **polimorfiktir**:
`target_type`'a göre `offer`, `product` ya da `query` gösterir. Bir kolon üç
tabloya birden referans veremeyeceği için **foreign key konulamaz**. Yani bu
iki tabloda referans bütünlüğü şemada yoktu; hiçbir yerde de yerine bir şey
konmamıştı.

Tohum betiği `offer` ve `product` tablolarını
`TRUNCATE ... RESTART IDENTITY CASCADE` ile boşaltıyordu. `CASCADE` foreign
key'leri izler; bu iki tabloya FK olmadığı için **değmedi**. `RESTART
IDENTITY` kimlikleri baştan dağıtınca eski vektörler sessizce **başka
ürünlere** yapıştı.

Sonuç eksik veri değil **yanlış veri**: benzerlik kenarları ve görsel arama
yanlış ürünü gösteriyor, hiçbir sayaç düşmüyor. Kabul kriteri tek koşu içinde
saydığı için görmedi; hata elle ve dolaylı yakalandı.

## Karar

### 1. Silme yönü motora bağlanır (migration `0014`)

İki `SECURITY DEFINER` fonksiyon, dört **deyim düzeyi** trigger:

```
enforce_polymorphic_delete()     AFTER DELETE   ON offer, product
enforce_polymorphic_truncate()   AFTER TRUNCATE ON offer, product
```

DELETE trigger'ı **geçiş tablosu** kullanır (`REFERENCING OLD TABLE AS
deleted`): 400 offer'lık bir silmede satır düzeyi trigger 400 kez koşardı, bu
tek `DELETE ... USING` ile biter. İki trigger aynı geçiş tablosu adını
kullandığı için tek fonksiyon ikisine de yeter; hedef tür `TG_ARGV[0]`'dan
gelir.

TRUNCATE trigger'ının geçiş tablosu yoktur ve gerekmez: `offer` boşaldıysa
`target_type = 'offer'` olan her satır tanımı gereği yetimdir.

### 2. Neden `SECURITY DEFINER`

Trigger fonksiyonu varsayılan olarak **çağıran** rolün yetkisiyle koşar. Bu
ölçüldü, varsayılmadı — PG 16 üzerinde tek kullanımlık bir şemayla:

| Deney | Sonuç |
| --- | --- |
| `SECURITY INVOKER`, çağıranın hedef tabloda DELETE'i yok | `ERROR: permission denied` |
| `SECURITY DEFINER`, aynı roller | temizlik yapıldı |
| `has_function_privilege('arilla_app', fn, 'EXECUTE')` | **`false`** |

Üçüncü satır kararın özü: `arilla_app` fonksiyonu **doğrudan çağırma
yetkisine bile sahip değil**, buna rağmen trigger çalışıyor. Yetki
tanımlayandan (`arilla`) geliyor. **`arilla_app` tarafında hiçbir GRANT
değişmiyor** — `0010`'un append-only tablosu aynen duruyor.

Ayrıca ölçüldü: `CASCADE` ile **dolaylı** truncate edilen tablonun trigger'ı
da ateşliyor (`TRUNCATE product CASCADE` → `offer` boşalır → `offer`
trigger'ı koşar). Tohumun gerçek senaryosu buydu.

Sertleştirme, `SECURITY DEFINER`'ın standart gereği: `search_path` fonksiyon
üzerinde sabit, `PUBLIC`'ten `EXECUTE` geri alınmış, gövdede dinamik SQL yok.

**Dürüst not:** `SECURITY DEFINER` *bugün* taşıyıcı değil — `0010`'un
`GRANT ... ON ALL TABLES`'ı yüzünden `arilla_app`'in `embedding` üzerinde
zaten DELETE'i var, `INVOKER` da çalışırdı. Taşıyıcı hale geldiği an
`embedding`'i `price_point` gibi sıkılaştırdığımız gün.

Bedeli sıfır değil: `DEFINER` çağıranın yetkisini atladığı için yetki
daraltmaları karşısında **sessiz kalır**. Bu, yetki modelinde duran bir
istisnadır ve ayrı bir kayda bağlandı —
[`0021`](0021-security-definer-yetki-istisnasi.md), yetkiler değiştirilirse
bakılacak kontrol listesiyle birlikte.

### 3. Yazma yönü izlemeye bağlanır

Trigger'ın kapatmadığı üç yol var:

1. **Yazma yönü** — var olmayan bir `target_id` ile INSERT.
2. `DISABLE TRIGGER` / `session_replication_role = replica`.
3. `generated_content.target_type` **serbest TEXT**'tir (`embedding`'in
   aksine CHECK kısıtı yok): `'ofer'` yazımı hem trigger'dan hem de naif bir
   yetim sorgusundan kaçar.

Bu yüzden `docs/ops.md` izleme tablosuna A2'deki `price_point_default`
maddesiyle **aynı biçimde** bir satır girer — eşik, aksiyon ve runbook ile,
aksiyonsuz bir sorgu olarak değil:

```
| embedding / generated_content yetim satırı | 0'dan büyük | Kritik — runbook |
```

Eşik `price_point_default` ile aynı sebeple **0'dan büyük**: yetim satır "az"
olamaz. Kontrol `pnpm db:orphans --check`, `pnpm db:partitions --check` ile
birebir aynı desen — dolu ise sıfırdan farklı çıkış kodu, izleme onu kullanır.

`target_type = 'query'` yetim sayılmaz: şema izin veriyor, karşılık gelen bir
tablo yok, bugün hiçbir yerden yazılmıyor.

### 4. Kalıcı regresyon testi

Denetimde bu maddenin açığı açıkça şuydu: **kalıcı test yoktu.** Üç iddia
`pnpm db:verify` kapısına girdi:

| İddia | Nasıl |
| --- | --- |
| Dört trigger var ve **etkin** (`tgenabled = 'O'`) | `pg_trigger` katalog sorgusu |
| DELETE yolu gerçekten temizliyor | tek kullanımlık satırlar → `DELETE` → ölç → `ROLLBACK` |
| TRUNCATE yolu gerçekten temizliyor | `TRUNCATE offer CASCADE` → ölç → `ROLLBACK` |
| Yetim sayısı sıfır | `orphans.ts` ile ortak sorgu |

Testler **mutasyonla doğrulandı**: iki trigger fonksiyonunun gövdesi boşaltılıp
(trigger'lar etkin bırakılarak) `db:verify` koşuldu ve üç iddia da düştü —

```
HATA: offer silindi ama 2 polimorfik satir kaldi — trigger calismadi.
HATA: product silindi ama 2 polimorfik satir kaldi — trigger calismadi.
HATA: TRUNCATE offer sonrasi 801 offer vektoru kaldi — B3 ariza duruyor.
```

Yetim sorgusu ayrıca sahte bir yetim ve bozuk bir `target_type` ile denendi;
`db:orphans --check` ikisini de yakalayıp kod 1 döndü. Düşmeyen bir test
hiçbir şey kanıtlamaz.

Son olarak trigger, tohumun **gerçek** `TRUNCATE` listesi üzerinde
yalıtılarak ölçüldü — liste `embedding` çıkarılmış haliyle, yani B3'ün
yandığı andaki haliyle koşuldu (800 embedding yüklüyken, işlem geri
alınarak):

| | kalan `embedding` |
| --- | --- |
| trigger **kapalı** | **800** — arıza aynen geri geliyor |
| trigger **açık** | **0** |

Tohumun kendi `TRUNCATE` listesinde `embedding` ve `generated_content`
**duruyor**; bu ölçüm o listeyi devre dışı bırakıp yalnızca trigger'ın ne
yaptığını gösteriyor.

TRUNCATE probu `ACCESS EXCLUSIVE` kilit aldığı için yalnızca **yerel**
veritabanında koşar (`isLocal`, `scripts/lib.ts`). Atlandığında **atlandığı
yazılır**; sessizce geçmiş gibi görünmez.

## Reddedilen alternatifler

- **Yazma yolunda uygulama düzeyi varlık kontrolü.** Yanlış yönü koruyordu:
  vektörler yazıldıklarında geçerliydi, hedefleri sonradan silindiği için
  yetim kaldılar. Tek başına B3'ü engellemezdi.
- **Yazma yönünde trigger.** Her INSERT'te hedef tabloyu aramak toplu
  embedding yazımına maliyet bindirir; o yön izlemeye bağlandı.
- **Tohumun `TRUNCATE` listesine güvenmek.** Listeye `embedding` ve
  `generated_content` eklendi ve **kalıyor** — ama tek savunma olamaz: tohum
  dışındaki her silme yolu açık kalırdı. İki kat koruma çelişki değil;
  trigger devre dışı bırakılsa tohum yine doğru davranır.
- **`generated_content.target_type`'a CHECK kısıtı eklemek.** Doğru iş ama
  şema değişikliği ve `CLAUDE.md` 14. kural geriye uyumlu iki adım istiyor.
  Ayrı görev; o zamana kadar izleme sessiz bırakmıyor.

## Sonucu

- `pnpm db:orphans [--check]`
- `pnpm db:verify` artık polimorfik bütünlüğü de doğruluyor.
- `docs/ops.md`: izleme satırı + runbook.
- Şema değişmedi: `0014` yalnızca fonksiyon ve trigger ekler.
