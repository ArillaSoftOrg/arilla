import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  enabled: vi.fn(),
  access: vi.fn(),
  load: vi.fn(),
  resolve: vi.fn(),
  saved: vi.fn(),
  alerts: vi.fn(),
  save: vi.fn(),
  remove: vi.fn(),
  create: vi.fn(),
  delete: vi.fn(),
  comparison: vi.fn(),
  foreign: vi.fn(),
  alternatives: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("../lib/dal.ts", () => ({ verifySession: mocks.verifySession }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@arilla/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/db")>()),
  getDatabase: () => ({ db: true }),
}));
vi.mock("./chat-product-display.ts", () => ({ chatToolProduct: (item: unknown) => item }));
vi.mock("@arilla/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@arilla/core")>()),
  isChatDiscoveryEnabled: mocks.enabled,
  canAccessProduct: mocks.access,
  loadConversation: mocks.load,
  resolveProductSlug: mocks.resolve,
  listSavedItems: mocks.saved,
  listAlerts: mocks.alerts,
  saveItem: mocks.save,
  removeSavedItem: mocks.remove,
  createAlert: mocks.create,
  deleteAlert: mocks.delete,
  getProductPriceComparison: mocks.comparison,
  getProductForeignOffers: mocks.foreign,
  findAlternatives: mocks.alternatives,
}));

import {
  loadChatProductDetailsAction,
  loadChatSimilarProductsAction,
  loadChatToolAccountAction,
  setChatPriceAlarmAction,
  setChatProductSavedAction,
} from "./chat-product-actions.ts";

const ID = "11111111-1111-4111-8111-111111111111";
const product = {
  productId: 12,
  slug: "sneaker",
  title: "Spor ayakkabı",
  primaryImageUrl: null,
  brandName: "adidas",
  color: null,
};
const priceAlarm = {
  productId: 12,
  alertId: 44,
  kind: "price_drop",
  isActive: true,
  targetPrice: 200000,
};
const comparison = {
  merchantOffers: [{ merchantId: 1, inStock: false, stockUnknown: true, currentPrice: 300000 }],
  comparison: { mode: "single" },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.enabled.mockReturnValue(true);
  mocks.access.mockReturnValue(true);
  mocks.verifySession.mockResolvedValue({ id: 7 });
  mocks.load.mockResolvedValue({ id: ID });
  mocks.resolve.mockResolvedValue({ status: "found", product });
  mocks.saved.mockResolvedValue([{ productId: 12 }]);
  mocks.alerts.mockResolvedValue([priceAlarm]);
  mocks.comparison.mockResolvedValue(comparison);
  mocks.foreign.mockResolvedValue([]);
  mocks.alternatives.mockResolvedValue([]);
});

describe("sohbet ürün işlemlerinin sunucu sınırları", () => {
  it("oturum yoksa, ürün kapısı kapalıysa veya sohbet başkasınınsa veri değiştirmez", async () => {
    mocks.verifySession.mockResolvedValueOnce(null);
    expect(await setChatProductSavedAction(ID, "sneaker", true)).toEqual({
      status: "session_expired",
    });
    mocks.access.mockReturnValueOnce(false);
    expect(await setChatPriceAlarmAction(ID, "sneaker", 150000)).toEqual({ status: "not_found" });
    mocks.load.mockResolvedValueOnce(null);
    expect(await loadChatSimilarProductsAction(ID, "sneaker")).toEqual({ status: "not_found" });
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.load).toHaveBeenCalledWith({ db: true }, { userId: 7, conversationId: ID });
  });
  it("özellik kapalıyken veya kimlik geçersizken oturuma bile bakmaz", async () => {
    expect(await loadChatToolAccountAction("invalid")).toEqual({ status: "not_found" });
    mocks.enabled.mockReturnValue(false);
    expect(await setChatProductSavedAction(ID, "sneaker", true)).toEqual({ status: "not_found" });
    expect(mocks.verifySession).not.toHaveBeenCalled();
  });
  it("yayındaki gerçek ürün kimliğini ve oturumdaki kullanıcıyı kullanır", async () => {
    expect(await setChatProductSavedAction(ID, "sneaker", true)).toEqual({
      status: "ok",
      saved: true,
    });
    expect(mocks.save).toHaveBeenCalledWith({ db: true }, { userId: 7, productId: 12 });
    mocks.resolve.mockResolvedValueOnce({ status: "not_found" });
    expect(await setChatProductSavedAction(ID, "hidden", false)).toEqual({ status: "not_found" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });
  it("güncellenmeyen mevcut alarmı yeni hedef kurulmuş gibi raporlamaz", async () => {
    expect(await setChatPriceAlarmAction(ID, "sneaker", 175000)).toEqual({
      status: "ok",
      alarm: { productId: 12, alertId: 44, targetPrice: 200000 },
    });
    expect(mocks.create).toHaveBeenCalledWith(
      { db: true },
      { userId: 7, productId: 12, kind: "price_drop", targetPrice: 175000 },
    );
  });
  it("yalnızca o ürünün kendi aktif fiyat alarmını kaldırır; stok alarmını korur", async () => {
    mocks.alerts.mockResolvedValue([
      priceAlarm,
      { ...priceAlarm, alertId: 45, kind: "restock" },
      { ...priceAlarm, alertId: 46, productId: 99 },
    ]);
    expect(await setChatPriceAlarmAction(ID, "sneaker", null)).toEqual({
      status: "ok",
      alarm: null,
    });
    expect(mocks.delete).toHaveBeenCalledTimes(1);
    expect(mocks.delete).toHaveBeenCalledWith({ db: true }, { userId: 7, alertId: 44 });
  });
  it("TL teklifi yoksa alarm oluşturmaz; bozuk veya taşan tutarı kabul etmez", async () => {
    mocks.comparison.mockResolvedValue({ ...comparison, merchantOffers: [] });
    expect(await setChatPriceAlarmAction(ID, "sneaker", 200000)).toEqual({ status: "unsupported" });
    for (const value of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await setChatPriceAlarmAction(ID, "sneaker", value)).toEqual({ status: "invalid" });
    }
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("karşılaştırmayı üç ürünle sınırlar; bilinmeyen stok ve rengi uydurmaz", async () => {
    expect(await loadChatProductDetailsAction(ID, ["a", "b", "c", "d"])).toEqual({
      status: "invalid",
    });
    expect(await loadChatProductDetailsAction(ID, ["a", "a"])).toEqual({ status: "invalid" });
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(await loadChatProductDetailsAction(ID, ["sneaker"])).toMatchObject({
      status: "ok",
      products: [
        {
          productId: 12,
          color: null,
          stock: "Mağazada doğrula",
          priceKurus: 300000,
          meta: "1 mağaza",
        },
      ],
    });
  });
  it("boş benzerlik listesi ile servis hatasını ayırır", async () => {
    expect(await loadChatSimilarProductsAction(ID, "sneaker")).toEqual({
      status: "ok",
      products: [],
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.alternatives.mockRejectedValueOnce(new Error("offline"));
    expect(await loadChatSimilarProductsAction(ID, "sneaker")).toEqual({ status: "unavailable" });
    log.mockRestore();
  });
});
