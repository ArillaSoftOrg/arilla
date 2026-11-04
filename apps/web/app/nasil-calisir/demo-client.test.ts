// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HowItWorksDemo } from "./demo-client.tsx";

let host: HTMLDivElement;
let root: Root;
let observer: IntersectionObserverCallback;
let reduce = false;

beforeEach(() => {
  vi.useFakeTimers();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", () => ({
    matches: reduce,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observer = callback;
      }
      observe() {
        observer(
          [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
          this as unknown as IntersectionObserver,
        );
      }
      disconnect() {}
    },
  );
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  HTMLElement.prototype.scrollTo = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  reduce = false;
});
async function render() {
  await act(async () => root.render(createElement(HowItWorksDemo)));
}
async function click(text: string) {
  const button = [...host.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === text,
  );
  if (!button) throw new Error(`Missing button: ${text}`);
  await act(async () => button.click());
}
const phase = () => host.querySelector("[data-demo-phase]")?.getAttribute("data-demo-phase");

it("görünmüyorken bekler; oynatmayı duraklatır ve kaldığı yerden sürdürür", async () => {
  await render();
  await act(async () =>
    observer(
      [{ isIntersecting: false, intersectionRatio: 0 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  await act(async () => vi.advanceTimersByTime(5000));
  expect(phase()).toBe("0");
  await act(async () =>
    observer(
      [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
      {} as IntersectionObserver,
    ),
  );
  await act(async () => vi.advanceTimersByTime(2800));
  expect(phase()).toBe("1");
  await click("Duraklat");
  await act(async () => vi.advanceTimersByTime(6000));
  expect(phase()).toBe("1");
  await click("Oynat");
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => vi.advanceTimersByTime(6000));
  expect(phase()).toBe("1");
  await act(async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => vi.advanceTimersByTime(2000));
  expect(phase()).toBe("2");
  expect(host.textContent).toContain("Air Force 1");
});

it("hareket azaltma tercihi açıkken otomatik oynatmaz", async () => {
  reduce = true;
  await render();
  const initial = phase();
  await act(async () => vi.advanceTimersByTime(30000));
  expect(phase()).toBe(initial);
  expect(host.textContent).toContain("Yeniden oynat");
  expect(host.textContent).toContain("Tanıtım örneği");
});

it("kullanıcının örnek kaydını yeniden oynatırken sıfırlar", async () => {
  await render();
  await click("Kendin dene ↗");
  const save = host.querySelector<HTMLButtonElement>('button[aria-label^="Kaydet:"]');
  await act(async () => save?.click());
  expect(save?.getAttribute("aria-pressed")).toBe("true");
  expect(host.textContent).toContain("Örnekte: Ürün kaydedildi.");
  await click("Yeniden oynat");
  await click("Kendin dene ↗");
  expect(host.querySelector('button[aria-label^="Kaydet:"]')?.getAttribute("aria-pressed")).toBe(
    "false",
  );
});
