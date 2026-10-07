# 0071 - Blog yazı sayfaları

## Karar

`/blog/[slug]` yazı sayfaları statik, depoda tutulan içerikle yayınlanır. CMS yok.
Yazılar `apps/web/app/blog/articles/` altında tipli bloklardan oluşur
(`h2`, `p`, `ul`, `callout`).

- Yazılar özgün Türkçe metindir; başka bir sitenin yazısının çevirisi ya da
  kopyası değildir. Kaynak sitedeki başlık/konu listesi yalnızca konu fikri verir
  (`blog-sources.json` bunun kaydıdır).
- Yayına çıkmadan önce editör ekibi her yazıyı tek tek gözden geçirir; mevcut
  metinler taslak önizlemedir. Türkiye pazarına uymayan konular listeye alınmaz.
- Kartlar yalnızca yazısı yazılmış kayıtlarda link olur; yazısı olmayan kart
  eskisi gibi linksiz kalır. Sitemap yalnızca yazılmış yazıları listeler.
- Gövdede merchant'a giden link yoktur. Ürün linki gerekirse `click`
  attribution hattı (kural 8) üzerinden, ayrı bir blok türü olarak eklenir.
- Dış kaynak (dupe.com) affiliate linkleri hiçbir koşulda kopyalanmaz.

## Gerekçe

Yazı sayısı küçük ve değişim sıklığı düşük; CMS, bağımlılık ve şema maliyeti
getirir. Tipli bloklar editör incelemesini kolaylaştırır ve ileride DB'ye
taşımak için basit bir biçim sunar.

## Reddedilen

- Kaynak sitenin metninin çevirisi: telif ve özgünlük riski.
- Markdown dosyaları: link ve ham HTML denetimi zorlaşır.
- Şimdi veritabanında yazı tablosu: ihtiyaç yok, migration maliyeti var.
