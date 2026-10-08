import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_PREFIX,
  BOOTSTRAP_TTL_MS,
  type BootstrapStorage,
  stashBootstrap,
  takeBootstrap,
} from "./chat-bootstrap.ts";
import {
  type BootstrapImageStore,
  createImageStore,
  IMAGE_TTL_MS,
  type ImageRecord,
  type ImageRecordBackend,
  waitForImage,
} from "./chat-bootstrap-image.ts";
import { type OpenChatTabImageDeps, openChatInNewTabWithImage } from "./open-chat-tab.ts";

const KEY = "req-key-12345678";
const here = dirname(fileURLToPath(import.meta.url));

function memoryStorage(): BootstrapStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

function memoryBackend(options: { failOn?: "put" | "get" | "keys" } = {}) {
  const records = new Map<string, ImageRecord>();
  const backend: ImageRecordBackend = {
    async put(record) {
      if (options.failOn === "put") throw new Error("quota");
      records.set(record.nonce, record);
    },
    async get(nonce) {
      if (options.failOn === "get") throw new Error("blocked");
      return records.get(nonce);
    },
    async remove(nonce) {
      records.delete(nonce);
    },
    async expiredKeys(cutoff) {
      if (options.failOn === "keys") throw new Error("blocked");
      return [...records.values()].filter((r) => r.createdAt <= cutoff).map((r) => r.nonce);
    },
  };
  return { backend, records };
}

const blob = () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });

describe("görselli bootstrap kaydı (localStorage'da yalnızca işaret)", () => {
  it("görselli kayıtta metin boş olabilir; anahtar taşınır, görsel baytı taşınmaz", () => {
    const storage = memoryStorage();
    stashBootstrap(storage, "n1", { text: "", submittedAt: 1_000, image: { requestKey: KEY } });
    const raw = storage.data.get(`${BOOTSTRAP_PREFIX}n1`) ?? "";
    expect(raw).not.toContain("data:");
    expect(takeBootstrap(storage, "n1", 2_000)).toEqual({
      text: "",
      submittedAt: 1_000,
      image: { requestKey: KEY },
    });
    expect(storage.data.size).toBe(0);
  });

  it("görselsiz boş metin hâlâ reddedilir; metin-only kayıt biçimi değişmez", () => {
    const storage = memoryStorage();
    stashBootstrap(storage, "blank", { text: "  ", submittedAt: Date.now() });
    expect(takeBootstrap(storage, "blank")).toBeNull();
    stashBootstrap(storage, "plain", { text: "merhaba", submittedAt: 5 });
    expect(takeBootstrap(storage, "plain", 6)).toEqual({ text: "merhaba", submittedAt: 5 });
  });

  it("geçersiz görsel anahtarı kaydı görselli saymaz", () => {
    const storage = memoryStorage();
    storage.setItem(
      `${BOOTSTRAP_PREFIX}x`,
      JSON.stringify({ text: "", submittedAt: Date.now(), image: { requestKey: "a" } }),
    );
    expect(takeBootstrap(storage, "x")).toBeNull();
  });

  it("süresi dolan görselli kayıt yok sayılır", () => {
    const storage = memoryStorage();
    stashBootstrap(storage, "old", { text: "", submittedAt: 0, image: { requestKey: KEY } });
    expect(takeBootstrap(storage, "old", BOOTSTRAP_TTL_MS + 1)).toBeNull();
  });
});

describe("IndexedDB görsel deposu: kısa ömürlü, süpürülen, teslimde silinen", () => {
  it("yazar ve okur; okumak SİLMEZ (ağ hatasında aynı sekme yeniden deneyebilir)", async () => {
    const { backend } = memoryBackend();
    const store = createImageStore(backend);
    expect(await store.put("n1", blob(), 1_000)).toBe(true);
    expect(await store.read("n1", 2_000)).not.toBeNull();
    expect(await store.read("n1", 3_000)).not.toBeNull();
  });

  it("sunucu teslim alınca remove ile silinir; sonra okuma boş", async () => {
    const { backend, records } = memoryBackend();
    const store = createImageStore(backend);
    await store.put("n1", blob(), 1_000);
    await store.remove("n1");
    expect(records.size).toBe(0);
    expect(await store.read("n1", 1_500)).toBeNull();
  });

  it("süresi dolmuş kayıt okunmaz ve silinir", async () => {
    const { backend, records } = memoryBackend();
    const store = createImageStore(backend);
    await store.put("n1", blob(), 1_000);
    expect(await store.read("n1", 1_000 + IMAGE_TTL_MS + 1)).toBeNull();
    expect(records.has("n1")).toBe(false);
  });

  it("yeni yazma, terk edilmiş eski kayıtları süpürür; taze kayıt kalır", async () => {
    const { backend, records } = memoryBackend();
    const store = createImageStore(backend);
    await store.put("old", blob(), 0);
    await store.put("fresh", blob(), IMAGE_TTL_MS - 1_000);
    await store.put("new", blob(), IMAGE_TTL_MS + 5_000);
    expect([...records.keys()].sort()).toEqual(["fresh", "new"]);
  });

  it("sweep: süresi dolanları siler, kullanılabilirliği bildirir", async () => {
    const { backend, records } = memoryBackend();
    const store = createImageStore(backend);
    await store.put("old", blob(), 0);
    expect(await store.sweep(IMAGE_TTL_MS + 1)).toBe(true);
    expect(records.size).toBe(0);
    expect(await createImageStore(memoryBackend({ failOn: "keys" }).backend).sweep()).toBe(false);
  });

  it("depo yazamazsa put false döner (hiçbir şey sessizce yutulmaz)", async () => {
    const store = createImageStore(memoryBackend({ failOn: "put" }).backend);
    expect(await store.put("n1", blob())).toBe(false);
  });

  it("okuma hatası null verir, fırlatmaz", async () => {
    const store = createImageStore(memoryBackend({ failOn: "get" }).backend);
    expect(await store.read("n1")).toBeNull();
  });
});

describe("waitForImage (yeni sekme, ana sayfa yazarken bekler)", () => {
  it("sonradan yazılan görseli yakalar", async () => {
    const { backend } = memoryBackend();
    const store = createImageStore(backend);
    let polls = 0;
    const result = await waitForImage(store, "n1", {
      timeoutMs: 1_000,
      intervalMs: 10,
      sleep: async () => {
        polls += 1;
        if (polls === 3) await store.put("n1", blob());
      },
    });
    expect(result).not.toBeNull();
    expect(polls).toBe(3);
  });

  it("zaman aşımında null: sonsuz beklemez", async () => {
    const store = createImageStore(memoryBackend().backend);
    let t = 0;
    const result = await waitForImage(store, "yok", {
      timeoutMs: 500,
      intervalMs: 100,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    expect(result).toBeNull();
    expect(t).toBeGreaterThanOrEqual(500);
  });
});

describe("openChatInNewTabWithImage (metinle aynı hat)", () => {
  function setup(
    options: {
      open?: OpenChatTabImageDeps["open"];
      images?: BootstrapImageStore | null;
      storage?: BootstrapStorage | null;
    } = {},
  ) {
    const order: string[] = [];
    const storage = options.storage === undefined ? memoryStorage() : options.storage;
    const real = createImageStore(memoryBackend().backend);
    const images: BootstrapImageStore | null =
      options.images === undefined
        ? {
            ...real,
            put: async (nonce, b, now) => {
              order.push("put");
              return real.put(nonce, b, now);
            },
          }
        : options.images;
    const deps: OpenChatTabImageDeps = {
      open: vi.fn((href) => {
        order.push("open");
        return options.open ? options.open(href) : {};
      }),
      navigate: vi.fn(() => void order.push("navigate")),
      closeTab: vi.fn(() => void order.push("close")),
      storage,
      images,
      now: () => 5_000,
      nonce: () => "nonce-1",
    };
    return { deps, order, storage };
  }

  it("sıra: metin kaydı -> open (kullanıcı hareketi sürerken, ilk await'ten ÖNCE) -> görsel yazımı", async () => {
    const { deps, order, storage } = setup();
    const pending = openChatInNewTabWithImage(
      "buna benzer",
      { blob: blob(), requestKey: KEY },
      deps,
    );
    // Henüz hiçbir await çözülmeden: kayıt yazıldı ve sekme AÇILDI.
    expect(order).toEqual(["open", "put"]);
    expect(deps.open).toHaveBeenCalledWith("/sohbet/yeni?n=nonce-1");
    expect(
      JSON.parse(
        (storage as ReturnType<typeof memoryStorage>).data.get(`${BOOTSTRAP_PREFIX}nonce-1`) ??
          "{}",
      ),
    ).toEqual({
      text: "buna benzer",
      submittedAt: 5_000,
      image: { requestKey: KEY },
    });
    expect(await pending).toBe("opened");
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("yalnız görsel (metin yok) da aynı hattan geçer", async () => {
    const { deps } = setup();
    expect(await openChatInNewTabWithImage("", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "opened",
    );
    expect(deps.open).toHaveBeenCalledTimes(1);
  });

  it("mesaj ve görsel URL'ye girmez", async () => {
    const { deps } = setup();
    await openChatInNewTabWithImage("gizli metin", { blob: blob(), requestKey: KEY }, deps);
    const href = String((deps.open as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]);
    expect(href).toBe("/sohbet/yeni?n=nonce-1");
  });

  it("popup engellenirse görsel yazıldıktan SONRA aynı sekmede aynı kabuğa gider", async () => {
    const { deps, order } = setup({ open: () => null });
    expect(await openChatInNewTabWithImage("x", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "same_tab",
    );
    expect(order).toEqual(["open", "put", "navigate"]);
  });

  it("IndexedDB yok: sekme HİÇ açılmaz, fallback (mesaj aynı sekmede gönderilir), kayıt yazılmaz", async () => {
    const { deps, storage } = setup({ images: null });
    expect(await openChatInNewTabWithImage("x", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "fallback",
    );
    expect(deps.open).not.toHaveBeenCalled();
    expect((storage as ReturnType<typeof memoryStorage>).data.size).toBe(0);
  });

  it("localStorage yazılamıyorsa sekme açılmaz, fallback", async () => {
    const { deps } = setup({ storage: null });
    expect(await openChatInNewTabWithImage("x", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "fallback",
    );
    expect(deps.open).not.toHaveBeenCalled();
  });

  it("görsel yazılamazsa açılan sekme kapanır, metin kaydı silinir, fallback döner (kayıp yok)", async () => {
    const failing = createImageStore(memoryBackend({ failOn: "put" }).backend);
    const { deps, order, storage } = setup({ images: failing });
    expect(await openChatInNewTabWithImage("x", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "fallback",
    );
    expect(order).toEqual(["open", "close"]);
    expect((storage as ReturnType<typeof memoryStorage>).data.size).toBe(0);
    expect(deps.navigate).not.toHaveBeenCalled();
  });

  it("görsel yazılamaz ve popup da engellenmişse: sekme ya da gezinme yok, fallback", async () => {
    const failing = createImageStore(memoryBackend({ failOn: "put" }).backend);
    const { deps } = setup({ images: failing, open: () => null });
    expect(await openChatInNewTabWithImage("x", { blob: blob(), requestKey: KEY }, deps)).toBe(
      "fallback",
    );
    expect(deps.navigate).not.toHaveBeenCalled();
    expect(deps.closeTab).not.toHaveBeenCalled();
  });
});

describe("eski görsel arama akışına bağımlılık yok (karar 0079)", () => {
  const files = [
    "../home-search-composer-client.tsx",
    "chat-bootstrap-client.tsx",
    "chat-bootstrap-image.ts",
    "open-chat-tab.ts",
    "actions.ts",
    "../home-image-chat.ts",
  ];
  const forbidden = [
    "/ara/gorsel",
    "uploadImageForSearch",
    "usePhotoSearchUpload",
    "PhotoSearchButton",
    "photo-search-client",
    "startConversationWithImageAction",
  ];

  it.each(files)("%s eski akışa gönderme yapmaz", (file) => {
    const source = readFileSync(join(here, file), "utf8");
    for (const word of forbidden) expect(source).not.toContain(word);
  });

  it("görsel ve metin ana sayfada aynı sekme açma işlevlerinden geçer (ayrı rota yok)", () => {
    const source = readFileSync(join(here, "../home-search-composer-client.tsx"), "utf8");
    expect(source).toContain("openChatInNewTabWithImage");
    expect(source).toContain("openChatInNewTab(");
    expect(source).not.toMatch(/router\.push\(["'`]\/ara/);
    // Tek sunucu eylemi: görselli ve görselsiz ayni `startChatBootstrapAction`.
    expect(source).toContain("startChatBootstrapAction");
  });
});

describe("/ara/gorsel eski sayfa: kalıcı yönlendirme", () => {
  it("görsel verisi okumadan ana sayfaya taşır", async () => {
    vi.doMock("next/navigation", () => ({
      permanentRedirect: (href: string) => {
        throw new Error(`REDIRECT:${href}`);
      },
    }));
    const { default: Page } = await import("../ara/gorsel/page.tsx");
    expect(() => Page()).toThrow("REDIRECT:/");
    vi.doUnmock("next/navigation");
  });
});
