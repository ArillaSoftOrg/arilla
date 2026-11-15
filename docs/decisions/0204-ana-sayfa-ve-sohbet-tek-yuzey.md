# 0204 — Ana sayfa ve sohbet tek yüzey: `/?s=<id>`, `/?q=<sorgu>`

Tarih: 15 Kasım 2026. Kısmen değiştirir: 0176 (tek arama yüzeyi `/sohbet`), 0074 (konuşmalı keşif adresi).

## Karar

Ayrı bir sohbet sayfası yoktur. Sohbet ve arama turu ana sayfada (`/`) açılır:

- `/?s=<conversationId>`: mevcut (girişli kullanıcının) konuşması. UUID değilse ya da sohbet kapalıysa 404;
  girişsiz ziyaretçi `/giris?next=/?s=<id>`ye gider (giriş sonrası aynı konuşmaya döner).
- `/?q=<sorgu>` (+ `kategori`, `sort`, `sayfa`, `n`, `uyari`): arama turu (eski `/sohbet?q=`; anonim kullanılabilir,
  0002 duvarı, IntentV2, BGE-M3 sunumu aynen).
- `/` (parametresiz): bugünkü ana sayfa. Hero → sohbet geçişi aynı sayfada sunucu eylemi yönlendirmesiyle olur
  (`startConversationAction` → `/?s=<id>`); sohbet kabuğu (`chrome="chat"`, footer'sız) yumuşak giriş animasyonuyla açılır.
- `/sohbet` (kök) 404. `/sohbet/<uuid>` 308 ile `/?s=<uuid>` (eski bağlantılar; `sirala`/`ac` korunur).
  `/sohbet/yeni` ana sayfaya gider (yeni sekme aktarımı artık kullanılmaz; ana sayfa aynı sekmede çalışır).
- `/sohbet/link`, `/sohbet/misafir`, `/sohbet/gorsel/[id]` bu aşamada AYNEN kalır; `/ara` → `/` (308),
  `/ara/link` → `/sohbet/link`.

## Gerekçe

Tek sayfalı deneyim (ana sayfadan çıkmadan konuşma). Konuşma bileşenleri ve iş mantığı çoğaltılmaz:
`ConversationView` (eski `/sohbet/[id]` gövdesi) ve `SearchPage` aynen, yalnızca çağıran yer değişti.
Durum URL'de olduğu için yenileme, geri/ileri ve giriş sonrası dönüş çalışır.

## Gizlilik ve SEO

`/?s=` ve `/?q=` dizinlenmez: sayfa `robots: noindex, nofollow`, canonical `/`; `X-Robots-Tag: noindex, nofollow`
başlığı bu sorgu parametreleriyle (`next.config` `headers` `has: query`); `robots.txt`'te `Disallow: /*?s=`, `/*?q=`.
Parametresiz `/` indekslenir ve değişmez. Konuşma kimliği GA4/Umami yolunda zaten yoktur (sorgu parametresi atılır).

## Bakım kipi ve anonim oturum

`proxy.ts`: `/` + (`q` ya da `s`) bakım ilkesinde `/sohbet` sayılır (arama/sohbet bakımı bu yüzeyi de keser);
anonim oturum çerezi bu istekler için de verilir; `/?q=<ürün linki>` eskisi gibi `/sohbet/link`e gider.

## Reddedilen

- URL'siz (bellek içi) sohbet durumu: yenilemede ve geri tuşunda kaybolur.
- Intercepting/parallel route: doğrudan ziyarette ayrı tam sayfa üretir, "ayrı sohbet sayfası yok" şartına aykırı.
- Eski `/sohbet/[id]`yi 404 yapmak: e-posta/yer imi bağlantıları kırılır.
