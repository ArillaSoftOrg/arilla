// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HOME_CATEGORY,
  type HomeCategoryId,
  HomeCategoryPicker,
} from "./home-category-picker-client.tsx";

function Harness() {
  const [value, setValue] = useState<HomeCategoryId>(DEFAULT_HOME_CATEGORY);
  return createElement(
    "div",
    null,
    createElement(HomeCategoryPicker, { value, onChange: setValue }),
    createElement("output", { "data-testid": "value" }, value),
  );
}

describe("mobil ana sayfa kategori secici", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it("Parfum ile baslar ve secim yapildiginda kontrollu degeri degistirir", async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    expect(trigger?.textContent).toContain("Parfüm");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");

    await act(async () => trigger?.click());
    const moda = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
      (option) => option.textContent?.includes("Moda"),
    );
    await act(async () => moda?.click());

    expect(host.querySelector('[data-testid="value"]')?.textContent).toBe("moda");
    expect(trigger?.textContent).toContain("Moda");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("ok tuslariyla secenekler arasinda dolasir ve Escape ile tetikleyiciye doner", async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    await act(async () => trigger?.click());
    const options = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(document.activeElement?.textContent).toContain("Parfüm");

    await act(async () =>
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(document.activeElement).toBe(options[0]);

    await act(async () =>
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(host.querySelector('[role="listbox"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("disariya pointer basildiginda listeyi kapatir", async () => {
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup="listbox"]');
    await act(async () => trigger?.click());
    expect(host.querySelector('[role="listbox"]')).not.toBeNull();

    await act(async () =>
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })),
    );
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
});
