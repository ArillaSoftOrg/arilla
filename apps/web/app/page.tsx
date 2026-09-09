import { SearchForm } from "@arilla/ui";

/**
 * docs/pages.md "/" tablosu: logo + giris linki, arama girdisi, kisa
 * aciklama, altbilgi. Kesfet izgarasi E4'te (discovery_slot uretimi
 * henuz yok); giris linki E1'de gercek olacak.
 */
export default function HomePage() {
  return (
    <>
      <header style={{ display: "flex", justifyContent: "space-between", padding: 24 }}>
        <span style={{ fontWeight: 500 }}>Arilla</span>
        {/* E1'de gercek giris akisina baglanir. */}
        <a href="/giris">Giriş yap</a>
      </header>

      <main style={{ padding: 24, display: "grid", gap: 16, maxWidth: 640 }}>
        <SearchForm
          placeholder="Ürün adı yaz, link yapıştır veya fotoğraf yükle"
          submitLabel="Ara"
          autoFocus
        />
        <p>Bir ürün bul, aynısını veya benzerini farklı mağazalarda karşılaştır.</p>
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
