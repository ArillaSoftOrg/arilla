import { describe, expect, it } from "vitest";
import { searchWallKey } from "./search-wall.ts";

describe("Redis sayac anahtarlari", () => {
  it("arama duvari anahtari session_id'ye baglidir", () => {
    expect(searchWallKey("abc")).toBe("search-wall:abc");
  });
});
