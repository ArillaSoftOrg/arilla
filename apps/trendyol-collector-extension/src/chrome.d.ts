/**
 * Eklentinin kullandigi KUCUK chrome API alt kumesi. Ek bagimlilik (@types/chrome) eklememek icin
 * elle yazildi. Icerik betikleri yalniz `storage`; arka plan zamanlayicisi (karar 0221) ayrica
 * `alarms` ve izin gerektirmeyen `tabs.create/update/remove` kullanir. Ag ve cerez API'si yok.
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
    const onInstalled: { addListener(cb: () => void): void };
    const onStartup: { addListener(cb: () => void): void };
  }
  namespace alarms {
    interface Alarm {
      name: string;
    }
    function create(name: string, info: { periodInMinutes: number; delayInMinutes?: number }): void;
    const onAlarm: { addListener(cb: (alarm: Alarm) => void): void };
  }
  namespace tabs {
    interface Tab {
      id?: number;
    }
    function create(props: { url: string; active?: boolean }): Promise<Tab>;
    function update(tabId: number, props: { url: string }): Promise<Tab | undefined>;
    function remove(tabId: number): Promise<void>;
  }
}
