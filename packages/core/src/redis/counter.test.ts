import { describe, expect, it, vi } from "vitest";
import { RedisUnavailableError } from "./client.ts";
import { incrementFixedWindow } from "./counter.ts";

type ExecResult = [Error | null, unknown][] | null;

function fakeRedis(exec: () => Promise<ExecResult>) {
  const calls: unknown[][] = [];
  const chain = {
    set: (...args: unknown[]) => {
      calls.push(["set", ...args]);
      return chain;
    },
    incr: (...args: unknown[]) => {
      calls.push(["incr", ...args]);
      return chain;
    },
    ttl: (...args: unknown[]) => {
      calls.push(["ttl", ...args]);
      return chain;
    },
    exec,
  };
  const expire = vi.fn(async () => 1);
  // biome-ignore lint/suspicious/noExplicitAny: test cift'i ioredis tipinin yalnizca kullanilan kismini taklit eder
  const client = { multi: () => chain, expire } as any;
  return { client, calls, expire };
}

describe("incrementFixedWindow()", () => {
  it("SET NX EX + INCR'i tek MULTI'de gonderir ve sayaci dondurur", async () => {
    const { client, calls, expire } = fakeRedis(async () => [
      [null, "OK"],
      [null, 1],
      [null, 60],
    ]);
    await expect(incrementFixedWindow("k", 60, client)).resolves.toBe(1);
    expect(calls).toEqual([
      ["set", "k", "0", "EX", 60, "NX"],
      ["incr", "k"],
      ["ttl", "k"],
    ]);
    expect(expire).not.toHaveBeenCalled();
  });

  it("TTL'siz eski bir anahtari onarir", async () => {
    const { client, expire } = fakeRedis(async () => [
      [null, null],
      [null, 7],
      [null, -1],
    ]);
    await expect(incrementFixedWindow("k", 60, client)).resolves.toBe(7);
    expect(expire).toHaveBeenCalledWith("k", 60);
  });

  it("baglanti hatasini RedisUnavailableError'a cevirir", async () => {
    const { client } = fakeRedis(async () => {
      throw new Error("Command timed out");
    });
    await expect(incrementFixedWindow("k", 60, client)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });

  it("komut duzeyindeki hatayi da RedisUnavailableError'a cevirir", async () => {
    const { client } = fakeRedis(async () => [
      [null, "OK"],
      [new Error("WRONGTYPE"), null],
      [null, 60],
    ]);
    await expect(incrementFixedWindow("k", 60, client)).rejects.toBeInstanceOf(
      RedisUnavailableError,
    );
  });
});
