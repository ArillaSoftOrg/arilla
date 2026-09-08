"""Eslestirme.

Katmanli, sirayla dener ve ilk kesin sonucta durur: gtin/mpn -> normalize
baslik + marka (trigram) -> gorsel embedding -> oznitelik uyumu. Sonuc
`match_candidate` tablosuna skorla yazilir; esik ustu `auto_accepted`, alti
`pending`.

B4 gorevinde doldurulur. Regresyon test seti zorunludur.
"""
