import type { CapturedPage } from "@arilla/core/catalog-collection-trendyol-relay";

/** Eklenti deposu anahtarlari. Veri yalniz bu tarayicida kalir; hicbir yere gonderilmez. */
export const ARMED_KEY = "armedRunId";
export const QUEUE_KEY = "captureQueue";

export async function readQueue(): Promise<CapturedPage[]> {
  const v = (await chrome.storage.local.get(QUEUE_KEY))[QUEUE_KEY];
  return Array.isArray(v) ? (v as CapturedPage[]) : [];
}

export async function armedRunId(): Promise<number | null> {
  const v = (await chrome.storage.local.get(ARMED_KEY))[ARMED_KEY];
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;
}
