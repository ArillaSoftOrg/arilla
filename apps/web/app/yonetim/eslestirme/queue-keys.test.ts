import { describe, expect, it } from "vitest";
import {
  DECISION_HOLD_MS,
  DecisionLock,
  dispatchQueueKey,
  keyToAction,
  type QueueReason,
  runLockedDecision,
} from "./queue-keys.ts";

/**
 * İstemcinin yaptığını birebir taklit eder: her `keydown` `dispatchQueueKey`'e
 * gider, kararlar `runLockedDecision` altında sunucu eylemini çağırır. Sunucu
 * yanıtı test tarafından elle çözülür (istek sürerken gelen tuşlar sınanır).
 */
function harness() {
  let clock = 0;
  const lock = new DecisionLock(() => clock);
  const serverCalls: { action: string; reason: QueueReason | null | undefined }[] = [];
  const pendingResponses: (() => void)[] = [];
  let rejecting = false;
  const runs: Promise<boolean>[] = [];

  const handlers = {
    decide: (action: "approve" | "skip" | "reject", reason?: QueueReason | null) => {
      runs.push(
        runLockedDecision(lock, async () => {
          if (action === "skip") return;
          serverCalls.push({ action, reason });
          await new Promise<void>((resolve) => pendingResponses.push(resolve));
        }),
      );
    },
    setRejecting: (open: boolean) => {
      rejecting = open;
    },
  };

  return {
    press(key: string, opts: { repeat?: boolean; targetTag?: string } = {}) {
      dispatchQueueKey(
        { key, repeat: opts.repeat, targetTag: opts.targetTag },
        rejecting,
        handlers,
      );
    },
    async respondAll() {
      for (const resolve of pendingResponses.splice(0)) resolve();
      await Promise.all(runs);
    },
    advance(ms: number) {
      clock += ms;
    },
    serverCalls,
    get rejecting() {
      return rejecting;
    },
  };
}

describe("eşleştirme kuyruğu klavye güvenliği (karar 0051)", () => {
  it("basılı tutulan A (tekrarlayan keydown) tam olarak BİR onay üretir", async () => {
    const h = harness();
    h.press("a");
    for (let i = 0; i < 30; i++) h.press("a", { repeat: true });
    await h.respondAll();
    // İstek bittikten sonra da tekrar olayları gelmeye devam eder.
    h.advance(DECISION_HOLD_MS * 5);
    for (let i = 0; i < 30; i++) h.press("a", { repeat: true });
    await h.respondAll();
    expect(h.serverCalls).toEqual([{ action: "approve", reason: undefined }]);
  });

  it("tarayıcı repeat bayrağı vermese bile istek sürerken ikinci karar gitmez", async () => {
    const h = harness();
    h.press("a");
    h.press("a");
    h.press("a");
    await h.respondAll();
    expect(h.serverCalls).toHaveLength(1);
  });

  it("karar bittikten hemen sonra (bekleme süresinde) gelen yeni basış yok sayılır; sonra kabul edilir", async () => {
    const h = harness();
    h.press("a");
    await h.respondAll();
    h.advance(DECISION_HOLD_MS - 1);
    h.press("a");
    await h.respondAll();
    expect(h.serverCalls).toHaveLength(1);
    h.advance(2);
    h.press("a");
    await h.respondAll();
    expect(h.serverCalls).toHaveLength(2);
  });

  it("red akışı: R + 2 tek red, basılı tutulan rakam tek karar", async () => {
    const h = harness();
    h.press("r");
    expect(h.rejecting).toBe(true);
    h.press("2");
    for (let i = 0; i < 10; i++) h.press("2", { repeat: true });
    await h.respondAll();
    expect(h.serverCalls).toEqual([{ action: "reject", reason: "different_color" }]);
  });

  it("tıklama da aynı kilitten geçer (çift tık tek karar)", async () => {
    const lock = new DecisionLock(() => 0);
    let calls = 0;
    const first = runLockedDecision(lock, async () => {
      calls += 1;
      await Promise.resolve();
    });
    const second = runLockedDecision(lock, async () => {
      calls += 1;
    });
    expect(await second).toBe(false);
    expect(await first).toBe(true);
    expect(calls).toBe(1);
  });

  it("hata atan karar kilidi bırakır (sonraki karar engellenmez)", async () => {
    let clock = 0;
    const lock = new DecisionLock(() => clock);
    await expect(
      runLockedDecision(lock, async () => {
        throw new Error("ağ");
      }),
    ).rejects.toThrow("ağ");
    clock += DECISION_HOLD_MS;
    expect(lock.tryAcquire()).toBe(true);
  });
});

describe("keyToAction", () => {
  it("değiştirici tuş ve yazı alanı kısayol tetiklemez", () => {
    expect(keyToAction({ key: "a", ctrlKey: true }, false)).toBeNull();
    expect(keyToAction({ key: "a", metaKey: true }, false)).toBeNull();
    expect(keyToAction({ key: "a", targetTag: "INPUT" }, false)).toBeNull();
    expect(keyToAction({ key: "a", targetTag: "textarea" }, false)).toBeNull();
    expect(keyToAction({ key: "A" }, false)).toEqual({ type: "approve" });
  });

  it("red modunda A onaylamaz; Esc kapatır, 0 nedensiz red", () => {
    expect(keyToAction({ key: "a" }, true)).toBeNull();
    expect(keyToAction({ key: "Escape" }, true)).toEqual({ type: "close-reject" });
    expect(keyToAction({ key: "0" }, true)).toEqual({ type: "reject", reason: null });
    expect(keyToAction({ key: "6" }, true)).toBeNull();
  });
});
