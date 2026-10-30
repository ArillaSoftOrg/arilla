import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SavedPriceChange } from "@arilla/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SAVED_COPY } from "./saved-copy.ts";

// Liste istemci bileseni `useRouter` ve sunucu eylemi kullanir; statik cizimde taklit edilir.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("./actions.ts", () => ({ removeSavedItemAction: async () => {} }));

import { SavedItemsListClient, type SavedItemsListClientItem } from "./saved-items-list-client.tsx";

const change = (
  kind: "down" | "up" | "same",
  diffKurus: number,
  percent: number,
): SavedPriceChange => ({
  kind,
  savedPriceKurus: 1000_00,
  currentPriceKurus: 1000_00,
  diffKurus,
  percent,
});

describe("SAVED_COPY.priceChange (karar 0159)", () => {
  it("düşüş, artış, değişmeme ve yetersiz veri", () => {
    expect(SAVED_COPY.priceChange(change("down", 250_00, 25))).toBe(
      "Kaydettiğinden beri 250 TL düştü (%25)",
    );
    expect(SAVED_COPY.priceChange(change("up", 1_234_50, 12))).toBe(
      "Kaydettiğinden beri 1.234,50 TL arttı (%12)",
    );
    expect(SAVED_COPY.priceChange(change("same", 0, 0))).toBe(
      "Kaydettiğinden beri fiyatı değişmedi",
    );
    expect(SAVED_COPY.priceChange({ kind: "insufficient" })).toBe(
      "Karşılaştırma için yeterli veri yok",
    );
  });

  it("yüzde sıfıra yuvarlanırsa '%0' yazılmaz", () => {
    expect(SAVED_COPY.priceChange(change("down", 1, 0))).toBe("Kaydettiğinden beri 0,01 TL düştü");
  });

  it("metinler copy.md'de; ALL CAPS ve yasak kelime yok", () => {
    const copyDoc = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../../docs/copy.md"),
      "utf8",
    );
    for (const key of ["down", "up", "same", "insufficient"]) {
      expect(copyDoc).toContain(`saved.price_change_${key}`);
    }
    const texts = [
      SAVED_COPY.priceChange(change("down", 250_00, 25)),
      SAVED_COPY.priceChange(change("up", 250_00, 25)),
      SAVED_COPY.priceChange(change("same", 0, 0)),
      SAVED_COPY.priceChange({ kind: "insufficient" }),
    ];
    for (const text of texts) {
      expect(copyDoc).toContain(text.replace(/ \(%\d+\)$/, "").replace(/\d[\d.,]* TL/, "{tutar}"));
      expect(text).not.toBe(text.toLocaleUpperCase("tr-TR"));
      expect(text.toLocaleLowerCase("tr-TR")).not.toMatch(/satın al|dupe|ucuz/);
    }
  });
});

describe("SavedItemsListClient", () => {
  const base: Omit<SavedItemsListClientItem, "productId" | "priceChange"> = {
    slug: "urun",
    title: "Ürün",
    primaryImageUrl: null,
    minPrice: 75_000,
    offerCount: 2,
  };
  const html = renderToStaticMarkup(
    createElement(SavedItemsListClient, {
      items: [
        { ...base, productId: 1, slug: "a", title: "A", priceChange: change("down", 250_00, 25) },
        { ...base, productId: 2, slug: "b", title: "B", priceChange: { kind: "insufficient" } },
        { ...base, productId: 3, slug: "c", title: "C" },
      ],
    }),
  );

  it("her kartın altında kendi göstergesi; tür data-kind ile", () => {
    expect(html).toContain('data-kind="down"');
    expect(html).toContain("Kaydettiğinden beri 250 TL düştü (%25)");
    expect(html).toContain('data-kind="insufficient"');
    expect(html).toContain("Karşılaştırma için yeterli veri yok");
  });

  it("değişim bilgisi gelmeyen kartta gösterge çizilmez", () => {
    expect(html.match(/data-kind=/g)).toHaveLength(2);
  });

  it("kaldırma düğmesi ve kart bağlantıları aynen (regresyon)", () => {
    for (const title of ["A", "B", "C"]) {
      expect(html).toContain(`aria-label="Kaydettiklerimden kaldır: ${title}"`);
    }
    expect(html).toContain('href="/urun/a"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(3);
  });
});
