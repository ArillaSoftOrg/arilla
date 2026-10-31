"""SADECE ORNEK esleme: sentetik fixture'larin sekline gore yazildi.

Hepsiburada ve Trendyol'dan gercek API/besleme erisimimiz YOK (karar 0118). Bu eslemeler
gercek yanit semasini temsil ETMEZ; adapter'larin yapilandirma tabanli calistigini ve
testleri gosterir. Gercek kaynak eklerken esleme gercek orneklerden yeniden yazilir.
"""

from __future__ import annotations

from platforms.adapters.mapping import FieldMapping

HEPSIBURADA_SAMPLE_MAPPING = FieldMapping(
    listing_id="sku",
    title="name",
    url="link",
    price="price.sellingPrice",
    list_price="price.originalPrice",
    currency_field="price.currency",
    in_stock="stock.available",
    brand="brand",
    category="categoryPath",
    category_separator=">",
    gtin="barcode",
    mpn="modelNo",
    images="images",
    options={"renk": "variant.color", "beden": "variant.size"},
)

TRENDYOL_SAMPLE_MAPPING = FieldMapping(
    listing_id="id",
    title="productName",
    url="url",
    price="salePrice",
    list_price="listPrice",
    in_stock="inStock",
    seller_id="merchant.id",
    seller_name="merchant.name",
    brand="brand.name",
    category="categoryName",
    gtin="barcode",
    images="images",
    image_key="url",
    options={"renk": "color"},
)

#: Genel CSV (`generic.csv`): noktali virgul, Turkce ondalik.
GENERIC_CSV_MAPPING = FieldMapping(
    listing_id="id",
    title="title",
    url="link",
    price="price",
    list_price="old_price",
    currency_field="currency",
    in_stock="availability",
    brand="brand",
    category="category",
    gtin="gtin",
    images="images",
)

#: Genel XML (`generic.xml`): `g:` ad alanli besleme; para birimi tanimdan gelir.
GENERIC_XML_MAPPING = FieldMapping(
    listing_id="id",
    title="title",
    url="link",
    price="price",
    in_stock="availability",
    brand="brand",
    category="product_type",
    gtin="gtin",
    images="additional_image_link",
)
