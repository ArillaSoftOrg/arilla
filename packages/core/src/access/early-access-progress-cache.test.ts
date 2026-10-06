import { describe, expect, it } from "vitest";
import { parseCachedProgress } from "./early-access-progress-cache.ts";

describe("parseCachedProgress", () => {
  it("geçerli önbellek kaydını okur", () => {
    expect(parseCachedProgress('{"count":78,"target":5000,"percent":1.6}')).toEqual({
      count: 78,
      target: 5000,
      percent: 1.6,
    });
  });

  it.each([
    "",
    "not json",
    "null",
    "{}",
    '{"count":-1,"target":5000,"percent":0}',
    '{"count":6000,"target":5000,"percent":100}',
    '{"count":1.5,"target":5000,"percent":0}',
    '{"count":10,"target":0,"percent":0}',
    '{"count":"10","target":5000,"percent":0.2}',
  ])("bozuk ya da geçersiz kaydı reddeder: %s", (raw) => {
    expect(parseCachedProgress(raw)).toBeNull();
  });
});
