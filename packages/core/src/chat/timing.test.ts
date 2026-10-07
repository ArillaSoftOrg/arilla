import { describe, expect, it } from "vitest";
import { createChatTimer, isChatTimingLogEnabled, logChatTimings } from "./timing.ts";

describe("createChatTimer", () => {
  it("sureleri toplar, hata olsa da yazar, toplami ekler", async () => {
    let t = 0;
    const timer = createChatTimer(() => t);
    await timer.time("gemini", async () => {
      t += 400;
    });
    await expect(
      timer.time("persist", async () => {
        t += 30;
        throw new Error("x");
      }),
    ).rejects.toThrow("x");
    await timer.time("gemini", async () => {
      t += 100;
    });
    expect(timer.finish()).toEqual({ "chat.gemini": 500, "chat.persist": 30, "chat.total": 530 });
  });
});

describe("logChatTimings", () => {
  const timings = { "chat.total": 12, "chat.gemini": 5 };

  it("varsayilan kapali: hicbir satir yazilmaz", () => {
    const lines: string[] = [];
    expect(isChatTimingLogEnabled({})).toBe(false);
    logChatTimings("turn", "answered", timings, {}, (line) => lines.push(line));
    expect(lines).toEqual([]);
  });

  it("acikken tek JSON satiri; yalnizca op, sonuc ve sureler", () => {
    const lines: string[] = [];
    logChatTimings("turn", "answered", timings, { CHAT_TIMING_LOG: "true" }, (line) =>
      lines.push(line),
    );
    expect(lines).toEqual([
      '[sohbet] timing {"op":"turn","outcome":"answered","chat.total":12,"chat.gemini":5}',
    ]);
  });
});
