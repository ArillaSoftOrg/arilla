import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));
vi.mock("./actions.ts", () => ({
  startChatBootstrapAction: vi.fn(),
  getTurnStatusAction: vi.fn(),
  runTurnAction: vi.fn(),
  sendMessageAction: vi.fn(),
  submitResultFeedbackAction: vi.fn(),
}));

import {
  BOOTSTRAP_PREFIX,
  BOOTSTRAP_TTL_MS,
  type BootstrapStorage,
  bootstrapHref,
  stashBootstrap,
  takeBootstrap,
} from "./chat-bootstrap.ts";
import { ChatBootstrap } from "./chat-bootstrap-client.tsx";
import { CHAT_COPY } from "./chat-copy.ts";
import { ChatPendingRow, ChatUserRow } from "./chat-shell-parts.tsx";
import { type OpenChatTabDeps, openChatInNewTab } from "./open-chat-tab.ts";

function memoryStorage(): BootstrapStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

describe("tek kullanimlik mesaj aktarimi", () => {
  it("yazar, bir kez okur ve ANINDA siler (ikinci okuma bos)", () => {
    const storage = memoryStorage();
    expect(stashBootstrap(storage, "n1", { text: "beyaz sneaker", submittedAt: 1_000 })).toBe(true);
    expect(takeBootstrap(storage, "n1", 2_000)).toEqual({
      text: "beyaz sneaker",
      submittedAt: 1_000,
    });
    expect(storage.data.size).toBe(0);
    expect(takeBootstrap(storage, "n1", 2_000)).toBeNull();
  });

  it("suresi dolmus, bozuk ya da bos kayit yok sayilir ve silinir", () => {
    const storage = memoryStorage();
    stashBootstrap(storage, "old", { text: "x", submittedAt: 0 });
    expect(takeBootstrap(storage, "old", BOOTSTRAP_TTL_MS + 1)).toBeNull();
    storage.setItem(`${BOOTSTRAP_PREFIX}bad`, "{not json");
    expect(takeBootstrap(storage, "bad")).toBeNull();
    stashBootstrap(storage, "blank", { text: "   ", submittedAt: Date.now() });
    expect(takeBootstrap(storage, "blank")).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it("nonce yoksa ya da depolama yoksa/atiyorsa guvenle null", () => {
    const storage = memoryStorage();
    expect(takeBootstrap(storage, null)).toBeNull();
    expect(takeBootstrap(null, "n")).toBeNull();
    const throwing: BootstrapStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(stashBootstrap(throwing, "n", { text: "x", submittedAt: 1 })).toBe(false);
    expect(takeBootstrap(throwing, "n")).toBeNull();
  });

  it("URL yalnizca nonce tasir; mesaj URL'ye girmez", () => {
    expect(bootstrapHref("abc-123")).toBe("/sohbet/yeni?n=abc-123");
  });
});

describe("openChatInNewTab (ana sayfa -> /sohbet/yeni)", () => {
  function setup(open: OpenChatTabDeps["open"] = () => ({})) {
    const order: string[] = [];
    const storage = memoryStorage();
    const setItem = storage.setItem;
    storage.setItem = (key, value) => {
      order.push("stash");
      setItem(key, value);
    };
    const deps: OpenChatTabDeps = {
      open: vi.fn((href) => {
        order.push("open");
        return open(href);
      }),
      navigate: vi.fn(() => void order.push("navigate")),
      storage,
      now: () => 5_000,
      nonce: () => "nonce-1",
    };
    return { deps, order, storage };
  }

  it("tamami senkron: once kayit, sonra open (kullanici hareketi surerken); bos sekme yok", () => {
    const { deps, order } = setup();
    expect(openChatInNewTab("merhaba", deps)).toBe(true);
    expect(order).toEqual(["stash", "open"]);
    expect(deps.open).toHaveBeenCalledWith("/sohbet/yeni?n=nonce-1");
  });

  it("mesaj URL'de degil depolamada; ana sayfa sekmesi gezinmez", () => {
    const { deps, storage } = setup();
    openChatInNewTab("beyaz spor ayakkabı", deps);
    const href = String((deps.open as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(href).not.toContain("ayakkab");
    expect(JSON.parse(storage.data.get(`${BOOTSTRAP_PREFIX}nonce-1`) ?? "{}")).toEqual({
      text: "beyaz spor ayakkabı",
      submittedAt: 5_000,
    });
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("popup engellenirse ayni sekmede ayni kabuga gider (kayit ayni depolamada)", () => {
    const { deps } = setup(() => null);
    expect(openChatInNewTab("merhaba", deps)).toBe(true);
    expect(deps.navigate).toHaveBeenCalledWith("/sohbet/yeni?n=nonce-1");
  });

  it("depolama yazilamazsa sekme HIC acilmaz ve false doner", () => {
    const { deps } = setup();
    deps.storage = null;
    expect(openChatInNewTab("merhaba", deps)).toBe(false);
    expect(deps.open).not.toHaveBeenCalled();
    expect(deps.navigate).not.toHaveBeenCalled();
  });
});

describe("/sohbet/yeni kabugu", () => {
  const html = renderToStaticMarkup(createElement(ChatBootstrap));

  it("ilk karede gercek kabuk: mesaj listesi ve gorunur ama kapali giris kutusu", () => {
    expect(html).toContain(`aria-label="${CHAT_COPY.threadLabel}"`);
    expect(html).toContain("<textarea");
    expect(html).toMatch(/<textarea[^>]*disabled/);
    expect(html).not.toContain("<footer");
  });

  it("teknik/yapay metin yok; sahte asistan cevabi yok", () => {
    for (const forbidden of [
      "Sohbet açılıyor",
      "Gemini",
      "AI hazırlanıyor",
      "düşünüyor",
      "about:blank",
    ]) {
      expect(html).not.toContain(forbidden);
    }
    expect(html).not.toContain("Asistan:");
  });
});

describe("ortak kabuk parcalari", () => {
  it("bekleme gostergesi yalnizca noktalar; metin yalnizca ekran okuyucuya", () => {
    const html = renderToStaticMarkup(createElement(ChatPendingRow));
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain(CHAT_COPY.thinking); // visually hidden
    expect(html).toMatch(/role="status"/);
  });

  it("kullanici balonu sunucudaki satirla ayni isaretleme", () => {
    const html = renderToStaticMarkup(createElement(ChatUserRow, { text: "merhaba" }));
    expect(html).toContain("merhaba");
    expect(html).toContain(`${CHAT_COPY.userLabel}: `);
  });
});
