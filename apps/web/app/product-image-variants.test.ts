import { ProductCard, ProductImage, resolveImageVariants } from "@arilla/ui";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

/**
 * Karar 0166: kaynak bazli gorsel varyanti. Dogrulanan Hepsiburada boyutlari
 * (300/450/680/1000, dikeyde oran korunarak) gercek CDN'de 200 dondu; ust sinir
 * 1000 cunku cok buyuk boyut 400 doner.
 */
const HB = "https://productimages.hepsiburada.net/s/462/222-222/110000498569710.jpg";
const HB_PORTRAIT = "https://productimages.hepsiburada.net/s/777/300-400/110001364979224.jpg";
const AE = "https://ae-pic-a1.aliexpress-media.com/kf/S5932c4f0aa2249daa0b09d44e1abf6356.jpg";

describe("resolveImageVariants", () => {
  it("Hepsiburada 222 kareyi dogrulanmis buyuk boyutlara cevirir", () => {
    const v = resolveImageVariants(HB);
    expect(v?.original).toBe(HB);
    expect(v?.src).toBe("https://productimages.hepsiburada.net/s/462/450-450/110000498569710.jpg");
    expect(v?.srcSet).toBe(
      [300, 450, 680, 1000]
        .map(
          (w) => `https://productimages.hepsiburada.net/s/462/${w}-${w}/110000498569710.jpg ${w}w`,
        )
        .join(", "),
    );
  });

  it("dikey 300-400 gorselde orani korur", () => {
    const v = resolveImageVariants(HB_PORTRAIT);
    expect(v?.src).toBe("https://productimages.hepsiburada.net/s/777/450-600/110001364979224.jpg");
    expect(v?.srcSet).toContain("/680-907/110001364979224.jpg 680w");
    expect(v?.srcSet).toContain("/1000-1333/110001364979224.jpg 1000w");
    // Kaynak genisligi (300) kendisi aday: ayni gorsel, gereksiz yeniden yazim yok.
    expect(v?.srcSet.startsWith(`${HB_PORTRAIT} 300w`)).toBe(true);
  });

  it("zaten buyuk, taninmayan ya da bozuk URL'leri degistirmez (null)", () => {
    const cases: Array<string | null | undefined> = [
      AE, // AliExpress: katalog zaten orijinal boyutta, donusum yok
      "https://cdn.shopify.com/s/files/1/0682/5230/3531/files/a.jpg?v=1",
      "https://productimages.hepsiburada.net/s/462/1500-1500/110000498569710.jpg", // zaten buyuk
      "https://productimages.hepsiburada.net/s/462/222-222/110000498569710.jpg?x=1", // sorgu: bilinmeyen bicim
      "http://productimages.hepsiburada.net/s/462/222-222/110000498569710.jpg", // https degil
      "https://productimages.hepsiburada.net.evil.example/s/462/222-222/a.jpg", // sahte host
      "https://productimages.hepsiburada.net/s/462/222-222/../x.jpg",
      "https://productimages.hepsiburada.net/s/462/222-9999/110000498569710.jpg", // asiri oran
      "https://productimages.hepsiburada.net/s/462/222/110000498569710.jpg", // farkli yol bicimi
      "",
      "not a url",
      null,
      undefined,
      `https://productimages.hepsiburada.net/s/1/222-222/${"a".repeat(3000)}.jpg`,
    ];
    for (const input of cases) expect(resolveImageVariants(input), String(input)).toBeNull();
  });
});

describe("ProductImage varyant cizimi", () => {
  const render = (props: Record<string, unknown>) =>
    renderToStaticMarkup(createElement(ProductImage, { alt: "", ...props } as never));

  it("sizes ile srcset + sizes uretir, src orta boyuttur", () => {
    const html = render({ src: HB, sizes: "46vw" });
    expect(html).toContain('sizes="46vw"');
    expect(html).toContain("srcSet=");
    expect(html).toContain(
      'src="https://productimages.hepsiburada.net/s/462/450-450/110000498569710.jpg"',
    );
    expect(html).not.toContain("222-222");
  });

  it("sizes olmadan srcset yok, yalnizca tek orta boyut", () => {
    const html = render({ src: HB });
    expect(html).not.toContain("srcSet");
    expect(html).toContain("450-450");
  });

  it("taninmayan kaynak degismeden kalir", () => {
    const html = render({ src: AE, sizes: "46vw" });
    expect(html).toContain(`src="${AE}"`);
    expect(html).not.toContain("srcSet");
    expect(html).not.toContain("sizes=");
  });

  it("referrerPolicy ve loading varyanta da tasinir", () => {
    const html = render({ src: HB, loading: "eager", referrerPolicy: "no-referrer" });
    expect(html).toContain('loading="eager"');
    expect(html.toLowerCase()).toContain('referrerpolicy="no-referrer"');
  });
});

describe("ProductCard (AI yaniti ve arama sonuclari ayni bilesen)", () => {
  it("Hepsiburada kartinda 222 yerine srcset kullanilir, AliExpress kartinda orijinal", () => {
    const base = { href: "/urun/x", title: "Apple iPhone 15 128 GB Siyah", minPrice: 5000000 };
    const hb = renderToStaticMarkup(createElement(ProductCard, { ...base, imageUrl: HB }));
    expect(hb).toContain("450-450");
    expect(hb).toContain("1000w");
    expect(hb).toContain("calc(50vw - 48px)");
    expect(hb).not.toContain("222-222");

    const ae = renderToStaticMarkup(createElement(ProductCard, { ...base, imageUrl: AE }));
    expect(ae).toContain(AE);
    expect(ae).not.toContain("srcSet");
  });
});
