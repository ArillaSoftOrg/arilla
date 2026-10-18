import {
  PRODUCT_CLASSIFICATION_FILTERS,
  PRODUCT_CONFIDENCE_FILTERS,
  PRODUCT_FRESHNESS_FILTERS,
  PRODUCT_IMAGE_FILTERS,
  PRODUCT_PRICE_FILTERS,
  PRODUCT_QUALITY_FILTERS,
  PRODUCT_STATE_FILTERS,
} from "@arilla/core";
import { describe, expect, it } from "vitest";
import {
  brandBasisLabel,
  CLASSIFICATION_FILTER_LABELS,
  CONFIDENCE_LABELS,
  categoryBasisLabel,
  classificationBadge,
  classificationDetailLabel,
  confidenceTone,
  FRESHNESS_LABELS,
  IMAGE_LABELS,
  PRICE_LABELS,
  publicationBadge,
  QUALITY_LABELS,
  STATE_LABELS,
  shortCategory,
} from "./product-labels.ts";

describe("ürünler ekranı etiketleri", () => {
  it("her filtre değerinin Türkçe etiketi var", () => {
    const sets: [readonly string[], Record<string, string>][] = [
      [PRODUCT_QUALITY_FILTERS, QUALITY_LABELS],
      [PRODUCT_STATE_FILTERS, STATE_LABELS],
      [PRODUCT_CLASSIFICATION_FILTERS, CLASSIFICATION_FILTER_LABELS],
      [PRODUCT_CONFIDENCE_FILTERS, CONFIDENCE_LABELS],
      [PRODUCT_PRICE_FILTERS, PRICE_LABELS],
      [PRODUCT_IMAGE_FILTERS, IMAGE_LABELS],
      [PRODUCT_FRESHNESS_FILTERS, FRESHNESS_LABELS],
    ];
    for (const [values, labels] of sets) {
      for (const value of values) expect(labels[value]).toMatch(/\S/);
    }
  });

  it("şemadaki tüm dayanak değerleri etiketli; bilinmeyen değer gizlenmez", () => {
    for (const basis of ["existing", "source", "title", "none", "ambiguous"]) {
      expect(brandBasisLabel(basis)).not.toBe(basis);
    }
    for (const basis of [
      "existing",
      "source",
      "source_title",
      "title",
      "none",
      "conflict",
      "low_confidence",
    ]) {
      expect(categoryBasisLabel(basis)).not.toBe(basis);
    }
    expect(categoryBasisLabel("yeni_dayanak")).toBe("yeni_dayanak");
    expect(classificationDetailLabel("concurrent_change")).toMatch(/değişti/);
    expect(classificationDetailLabel("bilinmeyen")).toBe("bilinmeyen");
    expect(classificationDetailLabel(null)).toBe("—");
  });

  it("durum rozetleri metin taşır (renk tek başına değil)", () => {
    expect(classificationBadge(null)).toEqual({ label: "Taranmadı", tone: "neutral" });
    expect(classificationBadge("error").tone).toBe("critical");
    expect(publicationBadge("published").label).toBe("Yayında");
    expect(publicationBadge("garip").label).toBe("garip");
  });

  it("güven tonu yazma eşiğini (80) izler", () => {
    expect(confidenceTone(80)).toBe("success");
    expect(confidenceTone(79)).toBe("warning");
    expect(confidenceTone(49)).toBe("critical");
  });

  it("kategori yolu kısaltılır, büyük harfe çevrilmez", () => {
    expect(shortCategory("elektronik/ses/kulaklik")).toBe("ses › kulaklik");
    expect(shortCategory("moda")).toBe("moda");
  });
});
