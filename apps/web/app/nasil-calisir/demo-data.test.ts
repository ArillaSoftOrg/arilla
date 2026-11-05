import { describe, expect, it } from "vitest";
import { createDemoBackend, DEMO_CARDS } from "./demo-data.ts";

describe("tanıtımın bağımsız örnek durumu", () => {
  it("kayıt ve alarmı yalnızca kendi örneğinde tutar; yeni gösterim temiz başlar", async () => {
    const first = createDemoBackend();
    const second = createDemoBackend();
    const product = DEMO_CARDS[0];
    if (!product) throw new Error("Demo card missing");
    expect(await first.save(product.slug, true)).toEqual({ status: "ok", saved: true });
    expect(await first.alarm(product.slug, 250050)).toMatchObject({
      status: "ok",
      alarm: { targetPrice: 250050 },
    });
    expect(await second.account()).toEqual({
      status: "ok",
      account: { savedProductIds: [], alarms: [] },
    });
    await first.save(product.slug, false);
    await first.alarm(product.slug, null);
    expect(await first.account()).toEqual({
      status: "ok",
      account: { savedProductIds: [], alarms: [] },
    });
  });
  it("hesap durumu kopya döner; bilinmeyen ürüne veya bozuk hedefe başarı dönmez", async () => {
    const backend = createDemoBackend();
    const snapshot = await backend.account();
    if (snapshot.status === "ok") snapshot.account.savedProductIds.push(999);
    expect(await backend.account()).toEqual({
      status: "ok",
      account: { savedProductIds: [], alarms: [] },
    });
    expect(await backend.save("missing", true)).toEqual({ status: "not_found" });
    expect(await backend.alarm(DEMO_CARDS[0]?.slug ?? "", -100)).toEqual({ status: "invalid" });
    expect(
      DEMO_CARDS.every(
        (item) => item.priceKurus === null && item.stock === "Bu örnekte gösterilmiyor",
      ),
    ).toBe(true);
  });
});
