/**
 * Icerik betigi (ManiCepte yonetim sayfasi /yonetim/katalog/toplama/trendyol): eklenti
 * deposundaki yakalamalari ayni pencereye `postMessage` ile iletir. Gonderimi sayfa yapar
 * (ayni koken + yonetici oturumu); bu betik ag istegi atmaz.
 */
import {
  ackCaptures,
  parseToExtensionMessage,
  RELAY_CHANNEL,
  type ToPageMessage,
} from "@arilla/core/catalog-collection-trendyol-relay";
import { ARMED_KEY, QUEUE_KEY, readQueue } from "./storage.ts";

function post(message: ToPageMessage): void {
  window.postMessage(message, window.location.origin);
}

async function pushQueue(): Promise<void> {
  const pages = await readQueue();
  if (pages.length > 0) post({ channel: RELAY_CHANNEL, type: "pages", pages: pages.slice(0, 200) });
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const msg = parseToExtensionMessage(event.data);
  if (!msg) return;
  void (async () => {
    if (msg.type === "arm") {
      await chrome.storage.local.set({ [ARMED_KEY]: msg.runId });
      await pushQueue();
    } else if (msg.type === "disarm") {
      // Kosu kapandi: bekleyen yakalamalar baska kosuya karismasin diye silinir.
      await chrome.storage.local.remove([ARMED_KEY, QUEUE_KEY]);
    } else if (msg.type === "ack") {
      await chrome.storage.local.set({
        [QUEUE_KEY]: ackCaptures(await readQueue(), msg.captureIds),
      });
    }
  })();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && QUEUE_KEY in changes) void pushQueue();
});

post({ channel: RELAY_CHANNEL, type: "hello", version: chrome.runtime.getManifest().version });
