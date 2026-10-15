"""Bagimsiz fiyat dogrulama ve resmi doviz kuru (karar 0113).

    python -m pricing fx                       # TCMB gunluk kur
    python -m pricing enqueue [--merchant SLUG] [--limit N] [--older-than-hours H]
    python -m pricing verify [--limit N]

Dogrulama besleme fiyatindan BAGIMSIZDIR: sonuc `price_verification`'a ayri
satir olarak yazilir, `offer` fiyati degistirilmez. Izinli canli kaynak yoksa
istek `unsupported` olur; sahte dogrulama sonucu uretilmez.
"""
