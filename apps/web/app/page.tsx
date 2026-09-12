import { getDiscoverySlots, todaySlotDate } from "@arilla/core";
import { getDatabase } from "@arilla/db";
import { ProductCard, SearchForm } from "@arilla/ui";
import { PhotoSearchButton } from "./photo-search-client.tsx";

/**
 * docs/pages.md "/" tablosu: logo + giris linki, arama girdisi, kisa
 * aciklama, kesfet izgarasi (E4), altbilgi. "Bos durum: yok. Kesfet
 * izgarasi her zaman doludur (curated havuz)" - discovery_slot hic
 * uretilmemisse (cron hic calismadiysa) bolum sessizce atlanir, bu tek
 * gercek bos durum.
 */
export default async function HomePage() {
  const items = await getDiscoverySlots(getDatabase(), todaySlotDate());

  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", padding: 24 }}>
        <span style={{ fontWeight: 500 }}>Arilla</span>
        <a href="/giris">Giriş yap</a>
      </header>

      <main style={{ padding: 24, display: "grid", gap: 32, maxWidth: 960 }}>
        <div style={{ display: "grid", gap: 16, maxWidth: 640 }}>
          <SearchForm
            placeholder="Ürün adı yaz, link yapıştır veya fotoğraf yükle"
            submitLabel="Ara"
            autoFocus
          />
          <PhotoSearchButton />
          <p>Bir ürün bul, aynısını veya benzerini farklı mağazalarda karşılaştır.</p>
        </div>

        {items.length > 0 ? (
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))",
              gap: 16,
            }}
          >
            {items.map((item) => (
              <ProductCard
                key={item.productId}
                href={`/urun/${item.slug}`}
                title={item.title}
                imageUrl={item.primaryImageUrl}
                minPrice={item.minPrice}
                offerCount={item.offerCount}
                offerCountLabel={(count) => `${count} mağaza`}
              />
            ))}
          </div>
        ) : null}
      </main>

      <footer style={{ padding: 24, fontSize: 13 }}>
        <p>
          Bazı bağlantılardan alışveriş yaptığında komisyon kazanabiliriz. Bu, sana gösterdiğimiz
          fiyatı değiştirmez.
        </p>
        <p>Fiyat ve stok bilgisi mağazalardan alınır, gecikmeli olabilir.</p>
      </footer>
    </>
  );
}
