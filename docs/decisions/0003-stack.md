# 0003 — TypeScript istek yolu, Python toplu işler, Drizzle

**Tarih:** 2026-09 · **Durum:** kabul edildi

## Karar

TypeScript (Next.js) istek yolunu, Python toplu işleri yürütür. İkisi
birbirini çağırmaz; tek iletişim kanalı PostgreSQL ve Redis kuyruğudur.
Veritabanı erişim katmanı Drizzle.

## Gerekçe

Bölme "frontend/backend" değil "istek yolunda olan / olmayan" ekseninde
yapıldı. Bu sayede iki taraf arasında senkron bağımlılık, API sözleşmesi ve
versiyon uyumu derdi oluşmuyor. Python bir saat düşse site çalışmaya devam
eder, sadece yeni ürün girmez.

Drizzle seçildi çünkü migration'ları düz SQL üretiyor (referans belge
`schema.sql` ile uyumlu), ayrı sorgu motoru ikilisi yok (serverless soğuk
başlangıç ve AWS'ye taşıma kolaylığı), pgvector desteği var ve ham SQL'e
düşmek kolay.

## Reddedilen alternatifler

Tek dilde (TypeScript) gitmek: embedding modelini kendimiz çalıştırmak
istediğimizde Python zorunlu hale geliyor. Prisma: çalışma zamanı ağır,
migration formatı kapalı, pgvector ek çaba istiyor.
