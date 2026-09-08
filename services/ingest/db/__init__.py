"""Veritabani erisimi.

Python tarafi semayi OKUR ve YAZAR ama migration URETMEZ — semanin tek sahibi
`packages/db`. Baglanti uygulama rolu (`arilla_app`) ile kurulur; o rolun
`price_point` ve `variant_stock_event` uzerinde UPDATE/DELETE yetkisi yoktur.
"""
