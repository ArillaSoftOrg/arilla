/**
 * Eşleştirme kuyruğu klavye ve karar güvenliği (docs/decisions/0051). React'ten
 * bağımsız, saf: tarayıcısız birim testlenir.
 *
 * İki ayrı koruma:
 * 1. Otomatik tekrar (`KeyboardEvent.repeat`) yok sayılır. Tuşu basılı tutmak
 *    tek karar üretir; her karar için tuş bırakılıp yeniden basılmalıdır.
 * 2. Karar kilidi (`DecisionLock`) EŞZAMANLI ve ref tabanlıdır. React durumu
 *    (`pending`) bir sonraki çizime kadar güncellenmez; o arada gelen ikinci
 *    tuş/tık aynı satıra ikinci kez karar gönderir, sunucu "zaten karara
 *    bağlanmış" der ve istemci SONRAKİ satırı kararsız atlardı. Kilit istek
 *    sürerken ve bittikten sonra kısa bir süre (`DECISION_HOLD_MS`) yeni
 *    kararı reddeder. Sunucunun işlem/çakışma korumaları aynen geçerlidir.
 */

export const QUEUE_REASONS = [
  "not_same_product",
  "different_color",
  "different_size",
  "bad_data",
  "other",
] as const;
export type QueueReason = (typeof QUEUE_REASONS)[number];

export type QueueAction =
  | { type: "approve" }
  | { type: "reject"; reason: QueueReason | null }
  | { type: "skip" }
  | { type: "open-reject" }
  | { type: "close-reject" };

export interface QueueKeyEvent {
  key: string;
  repeat?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** Olay hedefinin etiketi (`INPUT` vb.); yazı alanında kısayol çalışmaz. */
  targetTag?: string | null;
}

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** Tuş → eylem. Tekrar, değiştirici tuş ve yazı alanı → `null`. */
export function keyToAction(event: QueueKeyEvent, rejecting: boolean): QueueAction | null {
  if (event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey) return null;
  if (event.targetTag && TEXT_TAGS.has(event.targetTag.toUpperCase())) return null;
  const key = event.key.toLowerCase();
  if (rejecting) {
    if (key === "escape") return { type: "close-reject" };
    if (key === "0") return { type: "reject", reason: null };
    if (/^[1-5]$/.test(key)) {
      return { type: "reject", reason: QUEUE_REASONS[Number(key) - 1] ?? null };
    }
    return null;
  }
  if (key === "a") return { type: "approve" };
  if (key === "r") return { type: "open-reject" };
  if (key === "s") return { type: "skip" };
  return null;
}

/** Karar bittikten sonra yeni karar kabul edilmeden önceki kısa bekleme. */
export const DECISION_HOLD_MS = 400;

export class DecisionLock {
  private inFlight = false;
  private lockedUntil = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly holdMs: number = DECISION_HOLD_MS,
  ) {}

  /** Karar başlayabilir mi; başlayabiliyorsa kilidi alır. Eşzamanlı (ref). */
  tryAcquire(): boolean {
    if (this.inFlight || this.now() < this.lockedUntil) return false;
    this.inFlight = true;
    return true;
  }

  /** Karar bitti (başarılı ya da değil); kısa bekleme başlar. */
  release(): void {
    this.inFlight = false;
    this.lockedUntil = this.now() + this.holdMs;
  }

  get busy(): boolean {
    return this.inFlight;
  }
}

/**
 * Kilit altında tek karar: kilit alınamazsa `run` HİÇ çağrılmaz ve `false`
 * döner. `run` hata atsa da kilit bırakılır. İstemci her kararı (tuş ya da
 * tık) bundan geçirir.
 */
export async function runLockedDecision(
  lock: DecisionLock,
  run: () => Promise<void> | void,
): Promise<boolean> {
  if (!lock.tryAcquire()) return false;
  try {
    await run();
  } finally {
    lock.release();
  }
  return true;
}

export interface QueueKeyHandlers {
  decide: (action: "approve" | "skip" | "reject", reason?: QueueReason | null) => void;
  setRejecting: (open: boolean) => void;
}

/** Tek bir `keydown` olayını işler; istemcinin dinleyicisi yalnızca bunu çağırır. */
export function dispatchQueueKey(
  event: QueueKeyEvent,
  rejecting: boolean,
  handlers: QueueKeyHandlers,
): void {
  const action = keyToAction(event, rejecting);
  if (!action) return;
  if (action.type === "open-reject") handlers.setRejecting(true);
  else if (action.type === "close-reject") handlers.setRejecting(false);
  else if (action.type === "reject") handlers.decide("reject", action.reason);
  else handlers.decide(action.type);
}
