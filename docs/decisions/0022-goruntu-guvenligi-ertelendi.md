# 0022 — Görsel arama: yüz tespiti ve moderasyon ertelendi

**Tarih:** 2026-09 · **Durum:** kabul edildi (geçici — kapatılacak açık madde var)

## Karar

`docs/kvkk.md` "Yüklenen görseller" bölümü üç şey istiyor: yüz tespitinde
uyarı, ürün olmayan görselin reddi, uygunsuz içerik moderasyonu. Üçü de
**gerçek bir sağlayıcı/yöntem seçimi gerektiriyor** ve `0015`'in Jina için
yaptığı türden bir karşılaştırma hiçbiri için yapılmadı — ne bir sağlayıcı
adı, ne bir `.env.example` değişkeni, ne bir `docs/decisions/` kaydı vardı.

D4'ü bu üçü kapanana kadar tamamen durdurmak yerine — `0015`'in Jina için
kurduğu emsale uyarak (gerçek yol yazılır, hesap/karar gelene kadar
çalıştırılmaz) — boru hattı şu şekilde stub'lanır:

1. **`image_upload.has_face` her zaman `false` yazılır.** Gerçek bir yüz
   tespiti çalışmıyor; bu yüzden uyarı ekranı da hiç tetiklenmiyor. Yanlış
   bir "yüz yok" iddiası üretmek yerine, iddia hiç üretilmiyor.
2. **`rejected_not_product` ve `rejected_moderation` durumları şemada
   kalıyor ama hiçbir kod yolu bu durumlara yazmıyor.** Bugün her yüklenen
   görsel embed edilmeye çalışılır; reddetme mantığı yok.
3. Yükleme ekranındaki tek satır bilgi (KVKK madde 5) ve 30 günlük saklama
   sınırı (`purge_after`) **gerçek ve şimdiden uygulanıyor** — bunlar bir
   sağlayıcı kararına bağlı değil.

## Gerekçe

KVKK maddesi "ilk görsel arama satırı yazılmadan önce uygulanmalı" diyor —
ama bu üçü için henüz kod yazılmadan kapatılması gereken bir sağlayıcı
seçimi (maliyet, KVKK/veri ikametgahı, gecikme) var, tıpkı Jina'nın
`0015`'teki iki açık maddesi gibi. O karar `--fake-client` ile B3'ü
durdurmadı; burada da has_face=false ile D4'ü durdurmuyoruz — ama bu kez
**hiçbir dış çağrı bile yok**, sadece hiç uygulanmamış bir kural var. Bunu
sessizce atlamak yerine burada açıkça yazmak, ileride "neden hiç
reddedilen görsel yok" sorusuna baştan cevap veriyor.

## Kod yazılmadan önce kapatılacak açık nokta

- Yüz tespiti için sağlayıcı/yöntem (yerel bir kütüphane mi, barındırılan
  bir API mi — ikincisi KVKK'nın "yurt dışına aktarım" endişesini yeniden
  açar).
- Ürün/moderasyon sınıflandırması için sağlayıcı/yöntem — bu, embedding
  çağrısının **kendisinden** mi çıkarılacak (ör. bilinen hiçbir kategoriye
  yakın değilse reddet) yoksa ayrı bir çağrı mı olacak: ikincisi
  `CLAUDE.md` 1. kuralın tek istisnasını ikiye çıkarır, önce o kural
  gözden geçirilmeli.

Bu ikisi kapanmadan `rejected_not_product` / `rejected_moderation` durumlarına
gerçek bir yazan eklenmemeli.

## Sonucu

- `image_upload.has_face` sabit `false`.
- Görsel arama bugün yalnızca `pending → embedded` geçişini kullanır.
- Bu dosya, açık madde kapanınca "kabul edildi (nihai)" olarak güncellenir.
