// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ChatCardActions, ChatCompareTray } from "./chat-product-cards.tsx";
import { useChatProductTools } from "./chat-product-context.tsx";
import type { ChatToolBackend, ChatToolDetail } from "./chat-product-model.ts";
import { ChatProductToolsProvider } from "./chat-product-tools.tsx";

const products: ChatToolDetail[] = [1, 2, 3, 4].map((id) => ({
  productId: id,
  slug: `p${id}`,
  title: `Ürün ${id}`,
  imageUrl: null,
  brand: null,
  displayPrice: "3.000,00 TL",
  meta: "1 mağaza",
  color: null,
  stock: "Mağazada doğrula",
  variants: [],
  priceKurus: 300000,
  priceAlarmAvailable: true,
}));
let host: HTMLDivElement;
let root: Root;
let backend: ChatToolBackend;

function Selector() {
  const tools = useChatProductTools();
  return createElement(
    "div",
    {},
    ...products.map((product) =>
      createElement(
        "button",
        {
          type: "button",
          key: product.productId,
          onClick: () => tools?.toggleCompare(product),
        },
        `Seç ${product.productId}`,
      ),
    ),
  );
}
async function render() {
  await act(async () =>
    root.render(
      createElement(ChatProductToolsProvider, {
        conversationId: "test",
        backend,
        busy: false,
        prepareMessage: () => true,
        // biome-ignore lint/correctness/noChildrenProp: Test dosyası JSX kullanmaz; sağlayıcının zorunlu children tipi korunur.
        children: createElement(
          "div",
          {},
          createElement(ChatCardActions, { product: products[0] as ChatToolDetail }),
          createElement(Selector),
          createElement(ChatCompareTray),
        ),
      }),
    ),
  );
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}
beforeEach(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  backend = {
    account: vi
      .fn()
      .mockResolvedValue({ status: "ok", account: { savedProductIds: [], alarms: [] } }),
    save: vi.fn().mockResolvedValue({ status: "ok", saved: true }),
    alarm: vi.fn().mockResolvedValue({
      status: "ok",
      alarm: { productId: 1, alertId: 8, targetPrice: 200000 },
    }),
    details: vi.fn(async (slugs: string[]) => ({
      status: "ok" as const,
      products: products.filter((item) => slugs.includes(item.slug)),
    })),
    similar: vi.fn().mockResolvedValue({ status: "ok", products: [] }),
  };
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

it("kaydetme başarısızsa kalbi değiştirmez; başarılı sunucu yanıtından sonra değiştirir", async () => {
  await render();
  const heart = host.querySelector<HTMLButtonElement>('button[aria-label="Kaydet: Ürün 1"]');
  expect(heart?.disabled).toBe(false);
  vi.mocked(backend.save).mockResolvedValueOnce({ status: "unavailable" });
  await act(async () => heart?.click());
  expect(heart?.getAttribute("aria-pressed")).toBe("false");
  expect(host.textContent).toContain("İşlem tamamlanamadı");
  await act(async () => heart?.click());
  expect(heart?.getAttribute("aria-pressed")).toBe("true");
  expect(backend.save).toHaveBeenCalledWith("p1", true);
});

it("dördüncü ürünü seçmez ve karşılaştırma bilgilerini seçilen kimliklerle ister", async () => {
  await render();
  await click("Seç 1");
  await click("Seç 2");
  await click("Seç 3");
  await click("Seç 4");
  expect(host.textContent).toContain("3 ürün seçili");
  expect(host.textContent).toContain("En fazla 3 ürün");
  await click("Karşılaştır");
  expect(backend.details).toHaveBeenCalledWith(["p1", "p2", "p3"]);
  expect(host.querySelector("dialog")?.open).toBe(true);
  expect(host.querySelectorAll("tbody tr")).toHaveLength(6);
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Paneli kapat"]')?.click(),
  );
  expect(host.querySelector("dialog")?.open).toBe(false);
});

it("alarmda TL girişini kuruşa çevirir ve gerçek dönen hedefi gösterir", async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Ürün işlemleri: Ürün 1"]')?.click(),
  );
  await click("Fiyat alarmı kur");
  const input = host.querySelector("input");
  if (!input) throw new Error("Missing price input");
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      input,
      "2000,50",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () =>
    host
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
  expect(backend.alarm).toHaveBeenCalledWith("p1", 200050);
  expect(host.textContent).toContain("2.000 TL altına düşünce");
});

it("benzer ürün bulunamadığında boş durumu gösterir, liste uydurmaz", async () => {
  await render();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('button[aria-label="Ürün işlemleri: Ürün 1"]')?.click(),
  );
  await click("Benzerlerini bul");
  expect(backend.similar).toHaveBeenCalledWith("p1");
  expect(host.textContent).toContain("benzer bir seçenek bulunamadı");
});
