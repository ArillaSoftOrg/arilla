import { describe, expect, it } from "vitest";
import { COLLECTION_PAGE_PATH as HEADER_PATH } from "../../../../security-headers.ts";
import {
  COLLECTION_PAGE_PATH,
  loadedAsDocumentAt,
  needsReloadForCollection,
} from "./document-load.ts";

describe("loadedAsDocumentAt", () => {
  it("belge toplama sayfasinda yuklendiyse dogru", () => {
    expect(
      loadedAsDocumentAt("https://manicepte.com/yonetim/katalog/toplama", COLLECTION_PAGE_PATH),
    ).toBe(true);
    expect(
      loadedAsDocumentAt(
        "https://manicepte.com/yonetim/katalog/toplama/?x=1",
        COLLECTION_PAGE_PATH,
      ),
    ).toBe(true);
  });

  it("panelden istemci gecisiyle gelindiyse (ilk belge baska yol) yanlis", () => {
    expect(
      loadedAsDocumentAt("https://manicepte.com/yonetim/katalog/urunler", COLLECTION_PAGE_PATH),
    ).toBe(false);
    expect(loadedAsDocumentAt("https://manicepte.com/yonetim/ingest", COLLECTION_PAGE_PATH)).toBe(
      false,
    );
  });

  it("bilinmeyen ya da bozuk adres guvenli tarafta kalir", () => {
    expect(loadedAsDocumentAt(undefined, COLLECTION_PAGE_PATH)).toBe(false);
    expect(loadedAsDocumentAt("", COLLECTION_PAGE_PATH)).toBe(false);
    expect(loadedAsDocumentAt("not a url", COLLECTION_PAGE_PATH)).toBe(false);
  });

  it("otomatik yeniden yukleme yalniz baska yoldan gelinmisse; kayit yoksa dongu yok", () => {
    expect(needsReloadForCollection("https://manicepte.com/yonetim/katalog/urunler")).toBe(true);
    expect(needsReloadForCollection("https://manicepte.com/yonetim/katalog/toplama")).toBe(false);
    expect(needsReloadForCollection(undefined)).toBe(false);
    expect(needsReloadForCollection("")).toBe(false);
  });

  it("CSP basligindaki yol ile ayni", () => {
    expect(HEADER_PATH).toBe(COLLECTION_PAGE_PATH);
  });
});
