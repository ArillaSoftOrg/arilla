/**
 * Eklentinin kullandigi KUCUK chrome API alt kumesi (yalniz `storage.local`). Ek bagimlilik
 * (@types/chrome) eklememek icin elle yazildi; ag, sekme, cerez API'si kullanilmaz.
 */
declare namespace chrome {
  namespace storage {
    interface StorageChange {
      oldValue?: unknown;
      newValue?: unknown;
    }
    const local: {
      get(keys: string | string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(keys: string | string[]): Promise<void>;
    };
    const onChanged: {
      addListener(cb: (changes: Record<string, StorageChange>, area: string) => void): void;
    };
  }
  namespace runtime {
    function getManifest(): { version: string };
  }
}
