"""Katman 2 — kullanici tetikli tek URL cozumleme.

Sinirlar (`docs/decisions/0004`, `docs/architecture.md` Katman 2):

  * YALNIZCA kullanici istegiyle calisir. Zamanlanmis tarama yoktur.
  * YALNIZCA verilen URL getirilir. Sayfadaki linkler IZLENMEZ — bu bir
    tarayici degil, tek adresli bir cozumleyicidir.
  * `robots.txt` dinlenir ve atlatilmaz.
  * Once sayfadaki yapilandirilmis veri (schema.org JSON-LD) denenir; HTML
    ayristirma son caredir.
  * Sonuc CACHE DEGIL, kalici katalog kaydidir: `discovery_source='user_link'`.

Katman 3 (toplu kazima) yoktur ve eklenmeyecektir.
"""
