/**
 * Ana sayfa -> yeni sekme GORSEL aktarimi (docs/decisions/0079 madde 3-4).
 *
 * Mesaj metni `chat-bootstrap.ts` ile `localStorage`ta tek kullanimlik kayit olarak
 * gider; gorsel (<= 4 MB) oraya SIGMAZ ve base64 sisirir. Gorsel bu yuzden ayni nonce
 * anahtariyla IndexedDB'ye `Blob` olarak yazilir. Kurallar:
 *  - kisa omurlu: en fazla `IMAGE_TTL_MS`; suresi dolan kayit okunmaz ve silinir;
 *  - her yazma/acilista suresi dolmus butun kayitlar supurulur (terk edilen sekmeler);
 *  - okumak SILMEZ: kayit sunucu teslim aldiktan sonra `remove` ile silinir (basarisiz
 *    ag cagrisinda ayni sekme "Tekrar dene" ile gorseli yine bellekten yollar);
 *  - depolama yoksa/atarsa hicbir sey sessizce yutulmaz: `put` `false` doner ve cagiran
 *    ayni sekmede guvenli yola duser.
 * Sunucu tek dogruluk kaynagidir: dosya burada islenmez, dogrulama ve `preprocessImage`
 * sunucuda yapilir. Mantik bir `backend` arayuzu uzerinde oldugu icin testte sahte
 * depoyla calisir.
 */

export const IMAGE_DB_NAME = "arilla-chat-boot";
export const IMAGE_STORE_NAME = "images";
/** `chat-bootstrap.ts`teki metin kaydiyla ayni omur. */
export const IMAGE_TTL_MS = 60_000;

export interface ImageRecord {
  nonce: string;
  blob: Blob;
  /** Epoch ms. */
  createdAt: number;
}

/** IndexedDB'nin ince sarmalayicisi; testte bellek ici surum verilir. */
export interface ImageRecordBackend {
  put(record: ImageRecord): Promise<void>;
  get(nonce: string): Promise<ImageRecord | undefined>;
  remove(nonce: string): Promise<void>;
  /** `createdAt <= cutoff` olan kayitlarin nonce'lari (blob yuklenmeden). */
  expiredKeys(cutoff: number): Promise<string[]>;
}

export interface BootstrapImageStore {
  /** Suresi dolanlari supurur, sonra yazar. Herhangi bir hatada `false` (hicbir sey yazilmis sayilmaz). */
  put(nonce: string, blob: Blob, now?: number): Promise<boolean>;
  /** Kayit yoksa ya da suresi dolduysa (silinir) `null`. Okumak silmez. */
  read(nonce: string, now?: number): Promise<Blob | null>;
  /** Sunucu teslim aldiktan sonra ya da vazgecilince. Asla firlatmaz. */
  remove(nonce: string): Promise<void>;
  /** Suresi dolmus butun kayitlari siler. Depo kullanilabiliyor mu bilgisini doner. */
  sweep(now?: number): Promise<boolean>;
}

export function createImageStore(backend: ImageRecordBackend): BootstrapImageStore {
  async function sweep(now: number = Date.now()): Promise<boolean> {
    try {
      const expired = await backend.expiredKeys(now - IMAGE_TTL_MS);
      for (const nonce of expired) await backend.remove(nonce);
      return true;
    } catch {
      return false;
    }
  }
  return {
    async put(nonce, blob, now = Date.now()) {
      try {
        await sweep(now);
        await backend.put({ nonce, blob, createdAt: now });
        return true;
      } catch {
        return false;
      }
    },
    async read(nonce, now = Date.now()) {
      try {
        const record = await backend.get(nonce);
        if (!record) return null;
        if (now - record.createdAt > IMAGE_TTL_MS) {
          await backend.remove(nonce);
          return null;
        }
        return record.blob;
      } catch {
        return null;
      }
    },
    async remove(nonce) {
      try {
        await backend.remove(nonce);
      } catch {
        // Silinemiyorsa TTL ve sonraki supurme korur.
      }
    },
    sweep,
  };
}

/**
 * Yeni sekme, ana sayfa yazmayi bitirene kadar bekler: sekme senkron acilir (popup
 * engelleyici), gorsel ise sonradan yazilir. `null` = zaman asimi / yok.
 */
export async function waitForImage(
  store: BootstrapImageStore,
  nonce: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<Blob | null> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const intervalMs = options.intervalMs ?? 60;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  for (;;) {
    const blob = await store.read(nonce);
    if (blob) return blob;
    if (now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// ---------------------------------------------------------------------------
// Tarayici (IndexedDB)
// ---------------------------------------------------------------------------

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb"));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb"));
  });
}

function openDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(IMAGE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(IMAGE_STORE_NAME, { keyPath: "nonce" });
      store.createIndex("createdAt", "createdAt");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb"));
    req.onblocked = () => reject(new Error("indexeddb blocked"));
  });
}

function indexedDbBackend(factory: IDBFactory): ImageRecordBackend {
  let opened: Promise<IDBDatabase> | null = null;
  function database(): Promise<IDBDatabase> {
    if (!opened) {
      opened = openDatabase(factory).catch((error: unknown) => {
        opened = null; // sonraki cagri yeniden dener
        throw error;
      });
    }
    return opened;
  }
  return {
    async put(record) {
      const tx = (await database()).transaction(IMAGE_STORE_NAME, "readwrite");
      tx.objectStore(IMAGE_STORE_NAME).put(record);
      await transactionDone(tx);
    },
    async get(nonce) {
      const tx = (await database()).transaction(IMAGE_STORE_NAME, "readonly");
      const value = await request(tx.objectStore(IMAGE_STORE_NAME).get(nonce));
      return value as ImageRecord | undefined;
    },
    async remove(nonce) {
      const tx = (await database()).transaction(IMAGE_STORE_NAME, "readwrite");
      tx.objectStore(IMAGE_STORE_NAME).delete(nonce);
      await transactionDone(tx);
    },
    async expiredKeys(cutoff) {
      const tx = (await database()).transaction(IMAGE_STORE_NAME, "readonly");
      const cursorRequest = tx
        .objectStore(IMAGE_STORE_NAME)
        .index("createdAt")
        .openKeyCursor(IDBKeyRange.upperBound(cutoff));
      const keys: string[] = [];
      await new Promise<void>((resolve, reject) => {
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) return resolve();
          keys.push(String(cursor.primaryKey));
          cursor.continue();
        };
        cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error("indexeddb"));
      });
      return keys;
    },
  };
}

/** IndexedDB yoksa (SSR, eski tarayici, engelli) `null`. */
export function browserImageStore(): BootstrapImageStore | null {
  try {
    if (typeof indexedDB === "undefined" || indexedDB === null) return null;
    return createImageStore(indexedDbBackend(indexedDB));
  } catch {
    return null;
  }
}
