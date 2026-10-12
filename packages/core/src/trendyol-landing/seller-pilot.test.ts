import { describe, expect, it } from "vitest";

import {
  observationsFromInventoryAndPrice,
  planRefresh,
  redact,
  SellerQuota,
} from "./seller-pilot.ts";

// SENTETIK: yanit bicimi belgedeki "Onayli Urun V2 Stok ve Fiyat" ornegini izler
// (content[].variants[]{barcode, salePrice, listPrice, quantity}). Gercek satici verisi DEGIL.

describe("SellerQuota", () => {
  it("varsayilan pay: 50k kademede okuma 100/dk, yazma 10/dk", () => {
    const q = new SellerQuota({ tier: 50_000 });
    expect(q.limitPerMinute("read")).toBe(100);
    expect(q.limitPerMinute("write")).toBe(10);
  });
  it("yazma (buybox) payi dolunca istek reddedilir, dakika gecince acilir", () => {
    let t = 0;
    const q = new SellerQuota({ tier: 50_000, now: () => t });
    for (let i = 0; i < 10; i++) expect(q.tryAcquire("buybox")).toBe(true);
    expect(q.tryAcquire("buybox")).toBe(false);
    t = 60_001;
    expect(q.tryAcquire("buybox")).toBe(true);
  });
  it("ayni uc noktaya 10 sn'de 50'den fazla istek yok (genel kural)", () => {
    let t = 0;
    const q = new SellerQuota({ tier: "unlimited", share: { read: 1, write: 1 }, now: () => t });
    for (let i = 0; i < 50; i++) expect(q.tryAcquire("inventory-and-price")).toBe(true);
    expect(q.tryAcquire("inventory-and-price")).toBe(false);
    t = 10_001;
    expect(q.tryAcquire("inventory-and-price")).toBe(true);
  });
});

describe("planRefresh", () => {
  it("fiyat icin 50'li Stok-Fiyat, buybox 10'lu; butceyi asan ertelenir", () => {
    const q = new SellerQuota({ tier: 50_000 }); // okuma 100/dk, yazma 10/dk
    const barcodes = Array.from({ length: 120 }, (_, i) => `B${i}`);
    const plan = planRefresh(q, { barcodes, buyboxFor: barcodes });
    const inv = plan.calls.filter((c) => c.endpoint === "inventory-and-price");
    const bb = plan.calls.filter((c) => c.endpoint === "buybox");
    expect(inv.map((c) => c.barcodes.length)).toEqual([50, 50, 20]);
    expect(bb).toHaveLength(10); // yazma payi: 10 istek x 10 barkod
    expect(plan.deferred.filter((d) => d.endpoint === "buybox")).toHaveLength(2);
  });
});

describe("observationsFromInventoryAndPrice", () => {
  it("salePrice ve listPrice'i ayri gozlem olarak, kurus tamsayi ile uretir", () => {
    const body = {
      content: [
        {
          contentId: 857296094,
          variants: [
            { barcode: "195949771569", salePrice: 124999, listPrice: 127999, quantity: 3 },
          ],
        },
      ],
    };
    const obs = observationsFromInventoryAndPrice(body, "724838", "2026-10-12T00:00:00Z");
    expect(obs.map((o) => [o.kind, o.priceKurus, o.barcode, o.supplierId])).toEqual([
      ["seller.salePrice", 12_499_900, "195949771569", "724838"],
      ["seller.listPrice", 12_799_900, "195949771569", "724838"],
    ]);
  });
});

describe("redact", () => {
  it("anahtar, sir ve Basic basligini gizler", () => {
    const s = redact("key=AK123 secret=SS456 Authorization: Basic QUsxMjM6U1M0NTY=", {
      apiKey: "AK123",
      apiSecret: "SS456",
    });
    expect(s).not.toMatch(/AK123|SS456|QUsx/);
  });
});
